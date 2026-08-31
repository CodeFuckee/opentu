/**
 * supabase-sync 服务模块导出
 */

// 类型导出
export * from './types';

// 运行时配置
export { configureSupabaseSync, getSupabaseSyncConfig, getSupabaseSyncUser } from './runtime';

// 核心纯函数
export { calculateChecksum, entityKey, parseEntityKey } from './checksum';
export { compareEntityDiff, mergeBoardElements, resolveBoardConflict, toDiffInput } from './merge';
export type { DiffInputEntity, CompareOptions, MergeBoardInput, BoardLike } from './merge';

// 收集器
export { toSyncEntities, normalizeFromLocal, collectLocalSnapshot, createDefaultCollector } from './collector-core';
export type { LocalDataCollector, NormalizedLocalData, RawEntity } from './collector-core';
export { createLocalCollector, getLocalCollector, collectLocalDataForSync } from './local-collector';

// 仓库层（Supabase 读写）
export {
  fetchRemoteEntities,
  upsertRemoteEntities,
  softDeleteRemoteEntities,
  fetchRemoteMedia,
  upsertRemoteMedia,
  SYNC_DATA_TABLE,
  SYNC_MEDIA_TABLE,
} from './repository';

// 媒体同步
export { syncMediaToSupabase, collectLocalMediaUrls } from './media-sync';

// 同步引擎
export { runSync, BATCH_SIZE } from './sync-engine';
export type { SupabaseSyncUser, SupabaseSyncDeps, ApplyRemoteOptions } from './sync-engine';