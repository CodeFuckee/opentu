/**
 * 应用远程实体到本地（下载侧）
 *
 * 把云端下载的 SyncEntity[] 写回本地各数据源：
 * - board/folder/workspace_state → workspaceStorageService
 * - prompt → prompt-storage-service merge
 * - task → taskStorageWriter（归档/合并导入）
 * - workflow → workflowStorageWriter
 * - kb_* → knowledge-base-service（exportImportData 的 apply 语义，复用 kb-import-export-service）
 * - chat → chat-storage-service
 * - audio → audio-playlist-service
 * - character → character-storage-service
 * - asset / cache_media → 元数据写入（二进制由 media-sync 负责）
 * - settings → settings-manager（仅覆盖非敏感字段）
 * - custom_tools → toolbox-service
 *
 * 单个实体写入失败不中断整体，返回应用统计与失败列表。
 */

import { workspaceStorageService } from '../workspace-storage-service';
import { workspaceService } from '../workspace-service';
import {
  mergePromptHistory,
  mergeVideoPromptHistory,
  mergeImagePromptHistory,
} from '../prompt-storage-service';
import { workflowStorageWriter } from '../workflow-engine/workflow-storage-writer';
import * as chatStorage from '../chat-storage-service';
import { audioPlaylistService } from '../audio-playlist-service';
import { characterStorageService } from '../character-storage-service';
import { toolboxService } from '../toolbox-service';
import type { SyncEntity } from './types';
import { yieldToMain } from './checksum';

/** 应用远程实体到本地，返回应用数量 */
export async function applyRemoteEntities(
  entities: SyncEntity[]
): Promise<{ applied: number; failed: string[] }> {
  let applied = 0;
  const failed: string[] = [];
  let workspaceChanged = false;

  for (const entity of entities) {
    try {
      const ok = await applyOne(entity);
      if (ok) {
        applied++;
        // 画板/文件夹/工作区状态变更后需要刷新工作区内存映射，否则 UI 看不到新画板
        if (
          entity.entity_type === 'board' ||
          entity.entity_type === 'folder' ||
          entity.entity_type === 'workspace_state'
        ) {
          workspaceChanged = true;
        }
      }
    } catch {
      failed.push(`${entity.entity_type}:${entity.entity_id}`);
    }
    // 每处理 5 个让出主线程
    if (applied % 5 === 0) {
      await yieldToMain();
    }
  }

  // 画板/文件夹下载后刷新工作区，让新画板出现在画板列表/侧边栏中
  if (workspaceChanged) {
    try {
      await workspaceService.reload();
    } catch {
      // 刷新失败不影响已写入的存储数据（下次进入/刷新页面仍可见）
    }
  }

  return { applied, failed };
}

/** 应用单个实体；返回 false 表示该类型无需本地写入（如纯元数据） */
async function applyOne(entity: SyncEntity): Promise<boolean> {
  const content = entity.content as Record<string, unknown> | null;
  if (!content) {
    return false;
  }

  switch (entity.entity_type) {
    case 'board': {
      await workspaceStorageService.saveBoard(content as never);
      return true;
    }
    case 'folder': {
      await workspaceStorageService.saveFolder(content as never);
      return true;
    }
    case 'workspace_state': {
      await workspaceStorageService.saveState({
        ...(await workspaceStorageService.loadState()),
        ...content,
      } as never);
      return true;
    }
    case 'prompt': {
      const kind = content.kind as string | undefined;
      if (kind === 'videoPrompt') {
        mergeVideoPromptHistory([content as never]);
      } else if (kind === 'imagePrompt') {
        mergeImagePromptHistory([content as never]);
      } else {
        mergePromptHistory([content as never]);
      }
      return true;
    }
    case 'task': {
      // 任务恢复：通过 taskStorageWriter 的 importTasks 语义
      const { taskStorageWriter } = await import('../media-executor/task-storage-writer');
      await taskStorageWriter.importTasks([content as never], {
        replaceExisting: true,
      });
      return true;
    }
    case 'workflow': {
      await workflowStorageWriter.saveWorkflow(content as never);
      return true;
    }
    case 'kb_note':
    case 'kb_directory':
    case 'kb_tag':
    case 'kb_note_tag':
    case 'kb_note_content':
    case 'kb_note_image': {
      await applyKbEntity(entity);
      return true;
    }
    case 'chat_session': {
      // 会话写入：本地无则创建同名会话；已有则跳过（updatedAt 较新者由时间戳保证）
      const existing = await chatStorage.getSession(entity.entity_id);
      if (!existing) {
        const session = (await chatStorage.createSession()) as unknown as {
          id: string;
          title: string;
        };
        if (content.title && session) {
          await chatStorage.updateSession(session.id, { title: content.title as string });
        }
      }
      return true;
    }
    case 'chat_message': {
      // 直接写入（addMessage 内部幂等更新计数；已存在则覆盖，消息有 timestamp 保证新旧）
      await chatStorage.addMessage(content as never);
      return true;
    }
    case 'audio_playlist': {
      if ((content.playlistId || entity.entity_id.endsWith(':items')) && content.items) {
        // 播放列表条目（{playlistId, items}）
        await applyPlaylistItems(entity.entity_id, content);
      } else {
        await applyPlaylist(entity.entity_id, content);
      }
      return true;
    }
    case 'character': {
      await characterStorageService.saveCharacter(content as never);
      return true;
    }
    case 'asset': {
      // 素材元数据：直接写入（真实 blob 由 media-sync 下载）
      const { assetStorageService } = await import('../asset-storage-service');
      await assetStorageService.updateAssetMetadata(
        entity.entity_id,
        content as never
      );
      return true;
    }
    case 'cache_media': {
      // 缓存元数据：二进制由 media-sync 负责，这里只更新元数据
      const { unifiedCacheService } = await import('../unified-cache-service');
      await unifiedCacheService.cacheImage(entity.entity_id, content as never);
      return true;
    }
    case 'settings': {
      const { settingsManager } = await import('../../utils/settings-manager');
      // 仅覆盖非敏感设置（API Key 等敏感字段不写回）
      const safe = stripSensitiveKeys(content);
      await settingsManager.updateSettings(safe as never);
      return true;
    }
    case 'custom_tools': {
      const tools = content as unknown as {
        tools: unknown[];
        updatedAt: number;
      };
      if (Array.isArray(tools.tools)) {
        const { imported } = await toolboxService.importTools(tools.tools as never[]);
        return imported > 0;
      }
      return false;
    }
    default:
      return false;
  }
}

/** 知识库实体应用（复用 exportKnowledgeBaseData 的写入语义） */
async function applyKbEntity(entity: SyncEntity): Promise<void> {
  const { _getStoreInstances } = await import('../knowledge-base-service');
  const stores = _getStoreInstances();
  const content = entity.content as Record<string, unknown>;

  switch (entity.entity_type) {
    case 'kb_directory':
      await stores.directoriesStore.setItem(entity.entity_id, content);
      break;
    case 'kb_note': {
      const { content: noteContent, ...meta } = content;
      await stores.notesStore.setItem(entity.entity_id, meta);
      if (noteContent !== undefined) {
        await stores.noteContentsStore.setItem(entity.entity_id, {
          id: entity.entity_id,
          noteId: entity.entity_id,
          content: noteContent,
        });
      }
      break;
    }
    case 'kb_tag':
      await stores.tagsStore.setItem(entity.entity_id, content);
      break;
    case 'kb_note_tag':
      await stores.noteTagsStore.setItem(entity.entity_id, content);
      break;
    case 'kb_note_content':
      await stores.noteContentsStore.setItem(entity.entity_id, content);
      break;
    case 'kb_note_image':
      if (stores.noteImagesStore) {
        await stores.noteImagesStore.setItem(entity.entity_id, content);
      }
      break;
  }
}

/** 音频播放列表元数据写入（幂等：存在且较新则跳过） */
async function applyPlaylist(playlistId: string, content: Record<string, unknown>): Promise<void> {
  const { listPlaylists, createPlaylist, renamePlaylist } = audioPlaylistService;
  const playlists = await listPlaylists();
  const existing = playlists.find((p) => p.id === playlistId || p.name === content.name);
  if (existing) {
    const remoteUpdated = (content.updatedAt as number) ?? 0;
    if (remoteUpdated > (existing.updatedAt ?? 0)) {
      await renamePlaylist(existing.id, (content.name as string) ?? existing.name);
    }
    return;
  }
  const created = await createPlaylist((content.name as string) ?? playlistId);
  if (created.id && content.name && created.name !== content.name) {
    await renamePlaylist(created.id, content.name as string);
  }
}

/** 音频播放列表条目写入（合并去重：按 assetId/noteId 引用） */
async function applyPlaylistItems(
  entityId: string,
  content: Record<string, unknown>
): Promise<void> {
  const playlistId = (content.playlistId as string) ?? entityId.replace(':items', '');
  const items = (content.items as Array<{ assetId?: string; noteId?: string }>) ?? [];
  for (const item of items) {
    try {
      if (item.assetId) {
        await audioPlaylistService.addItemToPlaylist(
          { kind: 'asset', assetId: item.assetId } as never,
          playlistId
        );
      } else if (item.noteId) {
        await audioPlaylistService.addItemToPlaylist(
          { kind: 'reading', noteId: item.noteId } as never,
          playlistId
        );
      }
    } catch {
      // 单个条目失败跳过
    }
  }
}

/** 去除敏感字段（API Key 等），仅同步安全设置 */
function stripSensitiveKeys(content: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set([
    'apiKey',
    'apikey',
    'api_key',
    'secret',
    'token',
    'password',
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (SENSITIVE_KEYS.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}