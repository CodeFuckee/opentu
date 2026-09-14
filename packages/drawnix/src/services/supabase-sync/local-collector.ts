/**
 * 本地数据收集器（真实数据源接入）
 *
 * 实现 LocalDataCollector 接口，把各本地数据源归一化为 SyncEntity[]。
 * 收集逻辑在 local-collector.ts（真实数据源）；collector-core.ts 提供可单测的纯函数与聚合。
 *
 * 数据源：
 * - workspace：folders / boards / state
 * - tasks / workflows / prompts / knowledge-base / chat / audio / characters / assets / media 元数据 / settings / custom-tools
 */

import { workspaceStorageService } from '../workspace-storage-service';
import { taskStorageReader } from '../task-storage-reader';
import { workflowStorageReader } from '../workflow-storage-reader';
import {
  initPromptStorageCache,
  getPromptHistory,
  getVideoPromptHistory,
  getImagePromptHistory,
} from '../prompt-storage-service';
import * as chatStorage from '../chat-storage-service';
import { audioPlaylistService } from '../audio-playlist-service';
import { characterStorageService } from '../character-storage-service';
import { assetStorageService } from '../asset-storage-service';
import { unifiedCacheService } from '../unified-cache-service';
import { toolboxService } from '../toolbox-service';
import { exportAllData } from '../kb-import-export-service';
import { settingsManager } from '../../utils/settings-manager';
import { collectLocalSnapshot, createDefaultCollector } from './collector-core';
import type { LocalDataCollector, RawEntity } from './collector-core';
import { yieldToMain } from './checksum';

/** 敏感字段 key（脱敏过滤，避免 API Key 等上传云端） */
const SENSITIVE_KEYS = new Set([
  'apiKey',
  'apikey',
  'api_key',
  'secret',
  'token',
  'password',
  '_password',
  'apikeyMeta',
]);

/** 递归脱敏：删除敏感键（深拷贝，不改原对象） */
function sanitizeObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObject(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key)) {
        continue;
      }
      out[key] = sanitizeObject(item);
    }
    return out;
  }
  return value;
}

/** 单实例收集器（懒初始化） */
let collectorSingleton: LocalDataCollector | null = null;

/**
 * 创建真实数据源收集器。
 */
export function createLocalCollector(): LocalDataCollector {
  return createDefaultCollector({
    async collectWorkspace() {
      const [folders, boards, state] = await Promise.all([
        workspaceStorageService.loadAllFolders(),
        workspaceStorageService.loadAllBoards(),
        workspaceStorageService.loadState(),
      ]);
      const entities: RawEntity[] = [];
      for (const folder of folders) {
        entities.push({
          entityType: 'folder',
          entityId: folder.id,
          content: folder,
          updatedAt: folder.updatedAt,
        });
      }
      for (const board of boards) {
        entities.push({
          entityType: 'board',
          entityId: board.id,
          content: board,
          updatedAt: board.updatedAt,
        });
        if (entities.length % 5 === 0) {
          await yieldToMain();
        }
      }
      entities.push({
        entityType: 'workspace_state',
        entityId: 'default',
        content: state ?? {},
        updatedAt: Date.now(),
      });
      return { entities, stats: { total: entities.length } };
    },

    async collectTasks() {
      const allTasks = await taskStorageReader.getAllTasks({ includeArchived: true });
      const entities: RawEntity[] = [];
      for (const task of allTasks) {
        entities.push({
          entityType: 'task',
          entityId: task.id,
          content: task,
          updatedAt: task.updatedAt,
        });
        if (entities.length % 20 === 0) {
          await yieldToMain();
        }
      }
      return { entities, stats: { total: entities.length } };
    },

    async collectWorkflows() {
      const workflows = await workflowStorageReader.getAllWorkflows();
      const entities: RawEntity[] = workflows.map((w) => ({
        entityType: 'workflow',
        entityId: w.id,
        content: w,
        updatedAt: w.updatedAt,
      }));
      return { entities, stats: { total: entities.length } };
    },

    async collectPrompts() {
      await initPromptStorageCache();
      const promptHistory = getPromptHistory();
      const videoPromptHistory = getVideoPromptHistory();
      const imagePromptHistory = getImagePromptHistory();
      const entities: RawEntity[] = [];
      for (const item of promptHistory) {
        entities.push({
          entityType: 'prompt',
          entityId: item.id || String(item.timestamp),
          content: { kind: 'prompt', ...item },
          updatedAt: item.timestamp,
        });
      }
      for (const item of videoPromptHistory) {
        entities.push({
          entityType: 'prompt',
          entityId: item.id || String(item.timestamp),
          content: { kind: 'videoPrompt', ...item },
          updatedAt: item.timestamp,
        });
      }
      for (const item of imagePromptHistory) {
        entities.push({
          entityType: 'prompt',
          entityId: item.id || String(item.timestamp),
          content: { kind: 'imagePrompt', ...item },
          updatedAt: item.timestamp,
        });
      }
      return { entities, stats: { total: entities.length } };
    },

    async collectKnowledgeBase() {
      const kb = await exportAllData();
      const entities: RawEntity[] = [];
      for (const dir of kb.directories ?? []) {
        entities.push({
          entityType: 'kb_directory',
          entityId: dir.id,
          content: dir,
          updatedAt: dir.updatedAt ?? Date.now(),
        });
      }
      for (const note of kb.notes ?? []) {
        entities.push({
          entityType: 'kb_note',
          entityId: note.id,
          content: note,
          updatedAt: note.updatedAt ?? Date.now(),
        });
      }
      for (const tag of kb.tags ?? []) {
        entities.push({
          entityType: 'kb_tag',
          entityId: tag.id,
          content: tag,
          updatedAt: Date.now(),
        });
      }
      for (const nt of kb.noteTags ?? []) {
        entities.push({
          entityType: 'kb_note_tag',
          entityId: nt.id || `${nt.noteId}:${nt.tagId}`,
          content: nt,
          updatedAt: Date.now(),
        });
      }
      for (const img of kb.images ?? []) {
        entities.push({
          entityType: 'kb_note_image',
          entityId: img.id,
          content: img,
          updatedAt: Date.now(),
        });
      }
      return { entities, stats: { total: entities.length } };
    },

    async collectChat() {
      const sessions = await chatStorage.getAllSessions();
      const entities: RawEntity[] = [];
      // 并行读取各会话消息（逐个 await 会让大会话数场景的收集耗时线性放大）
      const messagesBySession = await Promise.all(
        sessions.map((session) => chatStorage.getMessages(session.id))
      );
      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        entities.push({
          entityType: 'chat_session',
          entityId: session.id,
          content: session,
          updatedAt: session.updatedAt,
        });
        for (const message of messagesBySession[i]) {
          entities.push({
            entityType: 'chat_message',
            entityId: message.id,
            content: message,
            updatedAt: message.timestamp ?? session.updatedAt,
          });
        }
      }
      return { entities, stats: { total: entities.length } };
    },

    async collectAudioPlaylists() {
      await audioPlaylistService.initialize();
      const playlists = await audioPlaylistService.listPlaylists();
      const entities: RawEntity[] = [];
      for (const playlist of playlists) {
        entities.push({
          entityType: 'audio_playlist',
          entityId: playlist.id,
          content: playlist,
          updatedAt: playlist.updatedAt,
        });
        const items = (await audioPlaylistService.listPlaylistItems())[playlist.id] ?? [];
        entities.push({
          entityType: 'audio_playlist',
          entityId: `${playlist.id}:items`,
          content: { playlistId: playlist.id, items },
          updatedAt: playlist.updatedAt,
        });
      }
      return { entities, stats: { total: entities.length } };
    },

    async collectCharacters() {
      const characters = await characterStorageService.getCharacters();
      const entities: RawEntity[] = characters.map((c) => ({
        entityType: 'character',
        entityId: c.id,
        content: c,
        updatedAt: c.createdAt ?? Date.now(),
      }));
      return { entities, stats: { total: entities.length } };
    },

    async collectAssets() {
      const assets = await assetStorageService.getAllAssets();
      const entities: RawEntity[] = assets.map((a) => ({
        entityType: 'asset',
        entityId: a.id,
        content: a,
        updatedAt: a.createdAt ?? Date.now(),
      }));
      return { entities, stats: { total: entities.length } };
    },

    async collectCacheMedia() {
      const cached = await unifiedCacheService.getAllCacheMetadata();
      // 只同步真正有内容的缓存：失败元数据（size=0 / cacheWarning，无二进制）
      // 上传到云端只会让另一台设备重复 404，且会污染本地的「本地已有」判断
      const entities: RawEntity[] = cached
        .filter((c) => c.size > 0 && !c.metadata?.cacheWarning)
        .map((c) => ({
          entityType: 'cache_media',
          entityId: c.url,
          content: c,
          updatedAt: c.cachedAt ?? Date.now(),
        }));
      return { entities, stats: { total: entities.length } };
    },

    async collectSettings() {
      // 读取全部设置，用 sanitizeObject 脱敏（去除 API Key 等敏感字段）后再上传
      const all = settingsManager.getSettings();
      const safe = sanitizeObject(all);
      return {
        entities: [
          {
            entityType: 'settings',
            entityId: 'default',
            content: safe,
            updatedAt: Date.now(),
          },
        ],
        stats: { total: 1 },
      };
    },

    async collectCustomTools() {
      const tools = toolboxService.exportTools();
      return {
        entities: [
          {
            entityType: 'custom_tools',
            entityId: 'default',
            content: tools,
            updatedAt: tools?.updatedAt ?? Date.now(),
          },
        ],
        stats: { total: 1 },
      };
    },
  });
}

/** 获取单例收集器 */
export function getLocalCollector(): LocalDataCollector {
  if (!collectorSingleton) {
    collectorSingleton = createLocalCollector();
  }
  return collectorSingleton;
}

/** 便捷入口：采集完整本地快照 */
export function collectLocalDataForSync() {
  return collectLocalSnapshot(getLocalCollector());
}

export type { LocalDataCollector, RawEntity } from './collector-core';