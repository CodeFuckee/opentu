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
import type { SyncEntity, SupabaseSyncResult } from './types';

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
  collectLocal: () => Promise<{ entities: SyncEntity[]; stats: { total: number } }>;
  /** 拉取远程全部实体（按用户） */
  fetchRemote: (client: unknown, userId: string) => Promise<SyncEntity[]>;
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
export async function runSync(deps: SupabaseSyncDeps): Promise<SupabaseSyncResult> {
  const startTime = Date.now();

  if (!deps.user) {
    return {
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      error: '未登录，无法同步',
      duration: Date.now() - startTime,
    };
  }

  try {
    // 1. 收集本地
    const local = await deps.collectLocal();
    const localEntities = local.entities;

    // 2. 拉取远程
    const remoteEntities = await deps.fetchRemote(deps.client, deps.user.id);

    // 3. 比较变更
    const knownRemoteKeys = new Set(
      remoteEntities.map((e) => entityKey(e.entity_type, e.entity_id))
    );

    const diff = compareEntityDiff(
      localEntities.map(toDiffInput),
      remoteEntities.map(toDiffInput),
      {
        lastSyncTime: deps.lastSyncTime ?? null,
        knownRemoteKeys,
      }
    );

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
      for (let i = 0; i < toUploadEntities.length; i += BATCH_SIZE) {
        const batch = toUploadEntities.slice(i, i + BATCH_SIZE);
        const { error } = await deps.upsertRemote(deps.client, deps.user.id, batch);
        if (error) {
          return {
            success: false,
            uploaded: 0,
            downloaded: 0,
            deleted: 0,
            conflicts: diff.conflicts.length,
            error: error instanceof Error ? error.message : String(error),
            duration: Date.now() - startTime,
          };
        }
        if (i % (BATCH_SIZE * 2) === 0) {
          await yieldToMain();
        }
      }
      uploaded = toUploadEntities.length;
    }

    // 4b. 冲突合并
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
          const { applied } = await deps.applyRemote({ entities: [remoteEntity] });
          downloaded += applied;
        }
      } else {
        // 保留本地 → 上传本地版本（以本地为准）
        const { error } = await deps.upsertRemote(
          deps.client,
          deps.user.id,
          [localEntity]
        );
        if (!error) {
          uploaded += 1;
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
      const { applied } = await deps.applyRemote({ entities: toDownloadEntities });
      downloaded += applied;
    }

    // 4d. 本地删除（墓碑下载侧）
    if (diff.toDeleteLocally.length > 0 && deps.deleteLocal) {
      const { deleted: deletedCount } = await deps.deleteLocal(diff.toDeleteLocally);
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

    // 6. 媒体同步（fire-and-forget：失败不阻塞主流程）
    if (deps.syncMedia) {
      deps.syncMedia(deps.client, deps.user.id).catch(() => {
        /* 媒体同步失败静默，主同步已成功 */
      });
    }

    return {
      success: true,
      uploaded,
      downloaded,
      deleted,
      conflicts: conflictedKeys.length,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

export { parseEntityKey };