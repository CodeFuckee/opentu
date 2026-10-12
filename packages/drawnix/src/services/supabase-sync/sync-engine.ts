/**
 * 同步引擎
 *
 * 编排一次完整同步：
 * 1. 收集本地快照（依赖注入 collectLocal）
 * 2. 拉取远程实体（依赖注入 fetchRemote）
 * 3. 比较变更（compareEntityDiff）
 * 4. 执行：上传本地变更 / 下载远程变更（applyRemote）/ 冲突合并（resolveConflict）/ 删除（deleteLocal）
 * 5. 云端墓碑软删除（softDeleteRemote）
 * 6. 媒体同步（syncMedia，fire-and-forget，失败不影响主流程）
 *
 * 全部 I/O 依赖注入，便于单测；批量 upsert 每批上限 BATCH_SIZE。
 */

import { compareEntityDiff, toDiffInput, type DiffInputEntity } from './merge';
import { entityKey, parseEntityKey, yieldToMain } from './checksum';
import type {
  RemoteEntityKey,
  SyncEntity,
  SyncStageTimings,
  SupabaseSyncResult,
} from './types';

/** 单批 upsert 实体数上限 */
export const BATCH_SIZE = 200;

/** 登录用户 */
export interface SupabaseSyncUser {
  id: string;
  email?: string;
}

/** 应用远程实体到本地（下载侧回调，宿主实现） */
export interface ApplyRemoteOptions {
  /** 被下载的实体 */
  entities: SyncEntity[];
}

/** 同步引擎依赖（全部可注入 mock） */
export interface SupabaseSyncDeps {
  /** Supabase 客户端 */
  client: unknown;
  /** 当前登录用户 */
  user: SupabaseSyncUser | null;
  /** 收集本地快照 */
  collectLocal: () => Promise<{
    entities: SyncEntity[];
    stats: { total: number };
  }>;
  /**
   * 拉取远程实体内容。options.sinceMs 非 null 时仅拉窗口内变更
   * （openspec improve-sync-performance）；实现可忽略窗口（退化为全量，兼容旧 mock）。
   */
  fetchRemote: (
    client: unknown,
    userId: string,
    options?: { sinceMs?: number | null }
  ) => Promise<SyncEntity[]>;
  /**
   * 远程实体键扫描（轻列全量，供墓碑判定）。可选：缺省时以 fetchRemote 结果的
   * 键充当 knownRemoteKeys（旧行为，内容全量拉取时等价）。
   */
  fetchRemoteKeys?: (
    client: unknown,
    userId: string
  ) => Promise<{ keys: RemoteEntityKey[]; error?: unknown }>;
  /** 批量 upsert 实体（含新增/更新） */
  upsertRemote: (
    client: unknown,
    userId: string,
    entities: SyncEntity[]
  ) => Promise<{ data?: unknown; error?: unknown }>;
  /** 软删除（云端标记 deleted_at） */
  softDeleteRemote: (
    client: unknown,
    userId: string,
    keys: string[]
  ) => Promise<{ data?: unknown; error?: unknown }>;
  /** 应用远程实体到本地，返回应用数量（下载侧） */
  applyRemote?: (options: ApplyRemoteOptions) => Promise<{ applied: number }>;
  /** 删除本地实体（墓碑下载侧），返回删除数量 */
  deleteLocal?: (keys: string[]) => Promise<{ deleted: number }>;
  /** 冲突解决：'remote' 下载远程 / 'local' 保留本地（返回 local 时引擎会把本地合并结果上传） */
  resolveConflict?: (
    local: DiffInputEntity,
    remote: DiffInputEntity,
    localEntity: SyncEntity,
    remoteEntity: SyncEntity
  ) => 'local' | 'remote';
  /** 媒体同步（可选，失败不影响主流程） */
  syncMedia?: (
    client: unknown,
    userId: string
  ) => Promise<{ uploaded: number; downloaded: number; failed: number }>;
  /** 上次同步时间（null = 首次同步） */
  lastSyncTime?: number | null;
}

/**
 * 执行一次完整同步。返回统一结果；任何错误捕获为 error 结果（不抛出）。
 */
export async function runSync(
  deps: SupabaseSyncDeps
): Promise<SupabaseSyncResult> {
  const startTime = Date.now();
  // 阶段计时（openspec improve-sync-performance）：失败路径也携带已流逝阶段
  const timings: SyncStageTimings = {
    collectMs: 0,
    remoteFetchMs: 0,
    diffMs: 0,
    uploadMs: 0,
    downloadMs: 0,
    totalMs: 0,
  };

  if (!deps.user) {
    timings.totalMs = Date.now() - startTime;
    return {
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      error: '未登录，无法同步',
      duration: Date.now() - startTime,
      stageTimings: { ...timings },
    };
  }

  try {
    // 1. 收集本地
    let t0 = performance.now();
    const local = await deps.collectLocal();
    timings.collectMs = Math.round(performance.now() - t0);
    const localEntities = local.entities;

    // 2. 拉取远程（键全量 + 内容窗口；openspec improve-sync-performance）
    t0 = performance.now();
    let knownRemoteKeys: Set<string>;
    let remoteEntities: SyncEntity[];
    if (deps.fetchRemoteKeys) {
      // 键全量扫描（轻列，墓碑判定语义与全量模式一致）
      const { keys, error: keysError } = await deps.fetchRemoteKeys(
        deps.client,
        deps.user.id
      );
      if (keysError) {
        timings.totalMs = Date.now() - startTime;
        return {
          success: false,
          uploaded: 0,
          downloaded: 0,
          deleted: 0,
          conflicts: 0,
          error:
            keysError instanceof Error ? keysError.message : String(keysError),
          duration: Date.now() - startTime,
          stageTimings: { ...timings },
        };
      }
      knownRemoteKeys = new Set(
        keys.map((k) => entityKey(k.entityType, k.entityId))
      );
      // 内容仅拉窗口内变更（首同步 lastSync=null 时实现内部退化为全量）
      remoteEntities = await deps.fetchRemote(deps.client, deps.user.id, {
        sinceMs: deps.lastSyncTime ?? null,
      });
    } else {
      remoteEntities = await deps.fetchRemote(deps.client, deps.user.id);
      knownRemoteKeys = new Set(
        remoteEntities.map((e) => entityKey(e.entity_type, e.entity_id))
      );
    }
    timings.remoteFetchMs = Math.round(performance.now() - t0);

    // 3. 比较变更
    t0 = performance.now();

    const diff = compareEntityDiff(
      localEntities.map(toDiffInput),
      remoteEntities.map(toDiffInput),
      {
        lastSyncTime: deps.lastSyncTime ?? null,
        knownRemoteKeys,
      }
    );
    timings.diffMs = Math.round(performance.now() - t0);

    // 增量模式缺口补齐（openspec improve-sync-performance）：merge 只遍历窗口
    // 内容，看不到「键扫描含、窗口内无变更、本地也缺失」的键——该组合意味着
    // 本地删除过（否则 collector 会收集它），并入云端墓碑集合。语义与全量模式
    // （knownRemoteKeys 来自内容结果）完全一致；首次同步不判墓碑。
    if (deps.fetchRemoteKeys && deps.lastSyncTime != null) {
      const localKeySet = new Set(
        localEntities.map((e) => entityKey(e.entity_type, e.entity_id))
      );
      const windowKeySet = new Set(
        remoteEntities.map((e) => entityKey(e.entity_type, e.entity_id))
      );
      for (const key of knownRemoteKeys) {
        if (!localKeySet.has(key) && !windowKeySet.has(key)) {
          diff.toTombstoneRemotely.push(key);
        }
      }
    }

    let uploaded = 0;
    let downloaded = 0;
    let deleted = 0;

    const remoteByKey = new Map<string, SyncEntity>(
      remoteEntities.map((e) => [entityKey(e.entity_type, e.entity_id), e])
    );
    const localByKey = new Map<string, SyncEntity>(
      localEntities.map((e) => [entityKey(e.entity_type, e.entity_id), e])
    );

    // 4a. 上传本地变更（分批）
    const toUploadEntities: SyncEntity[] = [];
    for (const key of diff.toUpload) {
      const entity = localByKey.get(key);
      if (entity) {
        toUploadEntities.push(entity);
      }
    }
    if (toUploadEntities.length > 0) {
      const upStart = performance.now();
      for (let i = 0; i < toUploadEntities.length; i += BATCH_SIZE) {
        const batch = toUploadEntities.slice(i, i + BATCH_SIZE);
        const { error } = await deps.upsertRemote(
          deps.client,
          deps.user.id,
          batch
        );
        if (error) {
          timings.uploadMs = Math.round(performance.now() - upStart);
          timings.totalMs = Date.now() - startTime;
          return {
            success: false,
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            conflicts: diff.conflicts.length,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime,
            stageTimings: { ...timings },
          };
        }
        if (i % (BATCH_SIZE * 2) === 0) {
          await yieldToMain();
        }
      }
      uploaded = toUploadEntities.length;
      timings.uploadMs = Math.round(performance.now() - upStart);
    }

    // 4b. 冲突合并
    const downloadStart = performance.now();
    const conflictedKeys = [...diff.conflicts];
    for (const key of conflictedKeys) {
      const localEntity = localByKey.get(key);
      const remoteEntity = remoteByKey.get(key);
      if (!localEntity || !remoteEntity) {
        continue;
      }
      const resolution = deps.resolveConflict
        ? deps.resolveConflict(
            toDiffInput(localEntity),
            toDiffInput(remoteEntity),
            localEntity,
            remoteEntity
          )
        : 'local';

      if (resolution === 'remote') {
        // 下载远程（覆盖本地）
        if (deps.applyRemote) {
          const { applied } = await deps.applyRemote({
            entities: [remoteEntity],
          });
          downloaded += applied;
        }
      } else {
        // 保留本地 → 上传本地版本（以本地为准）
        const { error } = await deps.upsertRemote(deps.client, deps.user.id, [
          localEntity,
        ]);
        if (!error) {
          uploaded += 1;
        } else {
          // 冲突「保留本地」的上传失败此前被静默忽略，留痕便于排查
          console.warn(
            '[SupabaseSync] conflict resolution upload failed:',
            key,
            error
          );
        }
      }
    }

    // 4c. 下载远程独有/单端修改
    const toDownloadEntities: SyncEntity[] = [];
    for (const key of diff.toDownload) {
      const entity = remoteByKey.get(key);
      if (entity) {
        toDownloadEntities.push(entity);
      }
    }
    if (toDownloadEntities.length > 0 && deps.applyRemote) {
      const { applied } = await deps.applyRemote({
        entities: toDownloadEntities,
      });
      downloaded += applied;
    }

    // 4d. 本地删除（墓碑下载侧）
    if (diff.toDeleteLocally.length > 0 && deps.deleteLocal) {
      const { deleted: deletedCount } = await deps.deleteLocal(
        diff.toDeleteLocally
      );
      deleted += deletedCount;
    }

    // 5. 云端墓碑（本地删除过）
    if (diff.toTombstoneRemotely.length > 0) {
      const { error } = await deps.softDeleteRemote(
        deps.client,
        deps.user.id,
        diff.toTombstoneRemotely
      );
      if (!error) {
        // 墓碑也算删除（本地已删，云端标记）；两个集合不相交，直接累加本组数量
        deleted += diff.toTombstoneRemotely.length;
      }
    }
    timings.downloadMs = Math.round(performance.now() - downloadStart);

    // 6. 媒体同步（fire-and-forget：失败不阻塞主流程，但需留痕可观测）
    if (deps.syncMedia) {
      deps.syncMedia(deps.client, deps.user.id).catch((error) => {
        console.warn('[SupabaseSync] media sync failed:', error);
      });
    }

    timings.totalMs = Date.now() - startTime;
    return {
      success: true,
      uploaded,
      downloaded,
      deleted,
      conflicts: conflictedKeys.length,
      duration: Date.now() - startTime,
      stageTimings: { ...timings },
    };
  } catch (error) {
    timings.totalMs = Date.now() - startTime;
    return {
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
      stageTimings: { ...timings },
    };
  }
}

export { parseEntityKey };
