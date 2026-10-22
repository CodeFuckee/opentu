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
  listOrchestratorGraphs,
} from '../workflow-orchestrator/graph-storage';
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
import {
  collectLocalSnapshot,
  createDefaultCollector,
  toSyncEntities,
} from './collector-core';
import type { LocalDataCollector, NormalizedLocalData, RawEntity } from './collector-core';
import { entityKey, parseEntityKey, yieldToMain } from './checksum';
import type { SyncEntity } from './types';

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

    async collectWorkflowGraphs() {
      const graphs = await listOrchestratorGraphs();
      const entities: RawEntity[] = graphs.map((g) => ({
        entityType: 'workflow_graph',
        entityId: g.id,
        content: g,
        updatedAt: g.updatedAt,
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

/** 实体类型 → 收集源（sweep/键级定向收集的路由表） */
const TYPE_SOURCE_MAP: Partial<Record<string, keyof LocalDataCollector>> = {
  board: 'collectWorkspace',
  folder: 'collectWorkspace',
  workspace_state: 'collectWorkspace',
  task: 'collectTasks',
  workflow: 'collectWorkflows',
  workflow_graph: 'collectWorkflowGraphs',
  prompt: 'collectPrompts',
  kb_note: 'collectKnowledgeBase',
  kb_directory: 'collectKnowledgeBase',
  kb_tag: 'collectKnowledgeBase',
  kb_note_tag: 'collectKnowledgeBase',
  kb_note_content: 'collectKnowledgeBase',
  kb_note_image: 'collectKnowledgeBase',
  chat_session: 'collectChat',
  chat_message: 'collectChat',
  audio_playlist: 'collectAudioPlaylists',
  character: 'collectCharacters',
  asset: 'collectAssets',
  cache_media: 'collectCacheMedia',
  settings: 'collectSettings',
  custom_tools: 'collectCustomTools',
};

export interface CollectForSyncOptions {
  /**
   * 类型级脏标记：整体收集这些类型的全部实体（不做窗口过滤——部分类型的
   * 内容变化不改 updatedAt，如提示词置顶，窗口过滤会漏传）。
   */
  sweepTypes?: string[];
  /**
   * 键级脏标记（'type:id'）：board 逐板定向读取，workspace_state 单读，
   * 其余类型整源收集后按 id 过滤。本地已不存在的键进 missingKeys。
   */
  specificKeys?: string[];
}

export interface CollectForSyncResult {
  entities: SyncEntity[];
  /** 键级请求但本地已不存在（本地删除）→ 推送侧向云端标记墓碑 */
  missingKeys: string[];
  /** 收集失败的类型 → 推送侧跳过对应键（保留 outbox 待重试，不误标墓碑） */
  failedTypes: string[];
}

/**
 * 按脏键定向收集（SyncPusher 专用）：成本 O(脏类型/脏板)，替代全量快照。
 */
export async function collectEntitiesForSync(
  options: CollectForSyncOptions
): Promise<CollectForSyncResult> {
  const collector = getLocalCollector();
  const sweepTypes = new Set(options.sweepTypes ?? []);
  const specificByType = new Map<string, Set<string>>();
  for (const key of options.specificKeys ?? []) {
    const parsed = parseEntityKey(key);
    if (!parsed) {
      continue;
    }
    const ids = specificByType.get(parsed.entityType) ?? new Set<string>();
    ids.add(parsed.entityId);
    specificByType.set(parsed.entityType, ids);
  }

  const entities: SyncEntity[] = [];
  const missingKeys: string[] = [];
  const failedTypes = new Set<string>();

  // board 键级定向：单板读取（画板是最大头，避免整源 loadAllBoards）
  const boardIds = specificByType.get('board');
  if (boardIds && !sweepTypes.has('board')) {
    specificByType.delete('board');
    try {
      for (const id of boardIds) {
        const board = await workspaceStorageService.loadBoard(id);
        if (board) {
          entities.push(
            ...toSyncEntities([
              { entityType: 'board', entityId: id, content: board, updatedAt: board.updatedAt },
            ])
          );
        } else {
          missingKeys.push(entityKey('board', id));
        }
      }
    } catch {
      failedTypes.add('board');
    }
  }

  // workspace_state 键级定向：单读工作区状态（避免为小状态整源收集全部画板）
  const stateIds = specificByType.get('workspace_state');
  if (stateIds && !sweepTypes.has('workspace_state')) {
    specificByType.delete('workspace_state');
    try {
      const state = await workspaceStorageService.loadState();
      for (const id of stateIds) {
        if (state) {
          entities.push(
            ...toSyncEntities([
              { entityType: 'workspace_state', entityId: id, content: state, updatedAt: Date.now() },
            ])
          );
        } else {
          missingKeys.push(entityKey('workspace_state', id));
        }
      }
    } catch {
      failedTypes.add('workspace_state');
    }
  }

  // 剩余类型：整源收集 → sweep 全留 / specific 按 id 过滤
  const sourceTypes = new Map<keyof LocalDataCollector, string[]>();
  const route = (type: string) => {
    const source = TYPE_SOURCE_MAP[type];
    if (!source) {
      return;
    }
    const types = sourceTypes.get(source) ?? [];
    if (!types.includes(type)) {
      types.push(type);
    }
    sourceTypes.set(source, types);
  };
  sweepTypes.forEach(route);
  for (const type of specificByType.keys()) {
    route(type);
  }

  for (const [source, types] of sourceTypes) {
    try {
      const fn = collector[source] as
        | (() => Promise<NormalizedLocalData>)
        | undefined;
      if (!fn) {
        continue;
      }
      const converted = toSyncEntities((await fn.call(collector)).entities);
      for (const entity of converted) {
        if (sweepTypes.has(entity.entity_type)) {
          entities.push(entity);
        } else {
          const ids = specificByType.get(entity.entity_type);
          if (ids?.has(entity.entity_id)) {
            entities.push(entity);
          }
        }
      }
      // 键级请求中未收集到的 id → 本地已删除
      for (const type of types) {
        const ids = specificByType.get(type);
        if (!ids) {
          continue;
        }
        for (const id of ids) {
          if (
            !converted.some(
              (e) => e.entity_type === type && e.entity_id === id
            )
          ) {
            missingKeys.push(entityKey(type, id));
          }
        }
      }
    } catch {
      for (const type of types) {
        failedTypes.add(type);
      }
    }
  }

  return { entities, missingKeys, failedTypes: [...failedTypes] };
}

export { toSyncEntities };

export type { LocalDataCollector, RawEntity } from './collector-core';