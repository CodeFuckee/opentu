/**
 * 收集器核心：LocalDataCollector 接口 + collectLocalSnapshot 聚合（与后端无关，可单测）
 */
import { calculateChecksum } from './checksum';
import type { SyncEntity, SyncEntityType } from './types';

/** 归一化前的一条原始实体 */
export interface RawEntity {
  entityType: SyncEntityType;
  entityId: string;
  content: unknown;
  updatedAt?: number;
}

/** 归一化后的本地数据（含统计） */
export interface NormalizedLocalData {
  entities: RawEntity[];
  stats: { total: number };
}

/** 本地数据收集器接口（各数据源一个函数） */
export interface LocalDataCollector {
  collectWorkspace: () => Promise<NormalizedLocalData>;
  collectTasks: () => Promise<NormalizedLocalData>;
  collectWorkflows: () => Promise<NormalizedLocalData>;
  /** 编排图（可选：旧 mock 未实现时快照收集跳过该源） */
  collectWorkflowGraphs?: () => Promise<NormalizedLocalData>;
  collectPrompts: () => Promise<NormalizedLocalData>;
  collectKnowledgeBase: () => Promise<NormalizedLocalData>;
  collectChat: () => Promise<NormalizedLocalData>;
  collectAudioPlaylists: () => Promise<NormalizedLocalData>;
  collectCharacters: () => Promise<NormalizedLocalData>;
  collectAssets: () => Promise<NormalizedLocalData>;
  collectCacheMedia: () => Promise<NormalizedLocalData>;
  collectSettings: () => Promise<NormalizedLocalData>;
  collectCustomTools: () => Promise<NormalizedLocalData>;
}

/** 把原始实体列表归一化为 SyncEntity[]（null 内容跳过，checksum 基于 JSON） */
export function toSyncEntities(raw: RawEntity[]): SyncEntity[] {
  return raw
    .filter((e) => e.content !== null && e.content !== undefined)
    .map((e) => {
      const checksum = calculateChecksum(JSON.stringify(e.content));
      return {
        entity_type: e.entityType,
        entity_id: e.entityId,
        content: e.content,
        checksum,
        updated_at: e.updatedAt ?? 0,
        deleted_at: null,
      };
    });
}

/** 返回实体列表 + 统计 */
export function normalizeFromLocal(
  data: NormalizedLocalData
): { entities: SyncEntity[]; stats: { total: number } } {
  const entities = toSyncEntities(data.entities);
  return { entities, stats: { total: entities.length } };
}

/** 用一组数据源实现构建 LocalDataCollector */
export function createDefaultCollector(impl: LocalDataCollector): LocalDataCollector {
  return { ...impl };
}

/**
 * 聚合所有数据源为完整本地快照（并行收集，返回统一实体列表 + 失败源）。
 * 单个数据源失败不阻塞整体。
 */
export async function collectLocalSnapshot(
  collector: LocalDataCollector
): Promise<{
  entities: SyncEntity[];
  stats: { total: number };
  failedSources: string[];
}> {
  const collectFns: Array<[string, () => Promise<NormalizedLocalData>]> = [
    ['workspace', () => collector.collectWorkspace()],
    ['tasks', () => collector.collectTasks()],
    ['workflows', () => collector.collectWorkflows()],
    // 可选源（旧 mock 未实现时跳过，不进 failedSources）
    ...(collector.collectWorkflowGraphs
      ? [['workflowGraphs', () => collector.collectWorkflowGraphs!()] as [string, () => Promise<NormalizedLocalData>]]
      : []),
    ['prompts', () => collector.collectPrompts()],
    ['knowledgeBase', () => collector.collectKnowledgeBase()],
    ['chat', () => collector.collectChat()],
    ['audioPlaylists', () => collector.collectAudioPlaylists()],
    ['characters', () => collector.collectCharacters()],
    ['assets', () => collector.collectAssets()],
    ['cacheMedia', () => collector.collectCacheMedia()],
    ['settings', () => collector.collectSettings()],
    ['customTools', () => collector.collectCustomTools()],
  ];

  const results = await Promise.allSettled(collectFns.map(([, fn]) => fn()));

  const entities: SyncEntity[] = [];
  const failedSources: string[] = [];
  let total = 0;

  collectFns.forEach(([name], i) => {
    const result = results[i];
    if (result.status === 'fulfilled') {
      const normalized = result.value;
      entities.push(...toSyncEntities(normalized.entities));
      total += normalized.stats.total;
    } else {
      failedSources.push(name);
    }
  });

  return { entities, stats: { total }, failedSources };
}

export { calculateChecksum };