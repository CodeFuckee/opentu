/**
 * 全量 reconcile（云端 ⇄ 本地）——openspec refactor-cloud-native-sync Phase C
 *
 * 从 SupabaseSyncContext 提取到模块层：登录/启动/切后台/切回前台/手动/Realtime
 * 触发的全量同步全部走这里，不再依赖任何 React 组件挂载（此前登录 reconcile
 * 挂在懒加载 Provider 上，不开弹窗就不跑——已修复）。
 *
 * 职责：
 * - 组装引擎依赖并执行 runSync（增量窗口、冲突合并、墓碑、媒体）
 * - 同步基线（lastSyncAt）持久化与读取
 * - 成功后修剪 outbox 中「本次已随全量上云/墓碑化」的条目
 * - 同步状态广播（UI isSyncing/最后同步时间消费）
 * - 与 SyncPusher 共享互斥锁，防交错写
 */

import { getSupabaseSyncConfig, getSupabaseSyncUser } from './runtime';
import { runSync } from './sync-engine';
import { collectLocalDataForSync } from './local-collector';
import {
  fetchRemoteEntities,
  fetchRemoteEntityKeys,
  softDeleteRemoteEntities,
  upsertRemoteEntities,
} from './repository';
import { syncMediaToSupabase } from './media-sync';
import { applyRemoteEntities } from './apply-remote';
import { deleteLocalEntities } from './delete-local';
import { mergeBoardElements, resolveBoardConflict, toDiffInput } from './merge';
import { kvStorageService } from '../kv-storage-service';
import { listOutbox, removeOutboxKeys } from './outbox';
import { runExclusiveSync, isSyncLocked as isSyncLockedNow } from './sync-mutex';
import { workspaceService } from '../workspace-service';
import type { SupabaseSyncConfig, SupabaseSyncResult, SyncEntity } from './types';

export const LAST_SYNC_KEY = 'supabase_sync_last_sync';

/** 最近已成功 reconcile 的防抖窗口：窗口内的重复触发直接跳过（force 除外） */
const RECENT_GUARD_MS = 5000;

const emptyResult: SupabaseSyncResult = {
  success: false,
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  duration: 0,
};

export interface ReconcileStatus {
  syncing: boolean;
  lastSyncAt: number | null;
}

const state: ReconcileStatus = { syncing: false, lastSyncAt: null };
let baselineLoaded = false;
const statusListeners = new Set<(status: ReconcileStatus) => void>();

function notify(): void {
  for (const listener of [...statusListeners]) {
    try {
      listener(state);
    } catch {
      // UI 订阅者异常不影响同步
    }
  }
}

/** 读取持久化的同步基线（懒加载，供 lastSyncTime 增量窗口使用） */
async function ensureBaseline(): Promise<void> {
  if (baselineLoaded) {
    return;
  }
  baselineLoaded = true;
  const saved = await kvStorageService
    .get<number>(LAST_SYNC_KEY)
    .catch(() => null);
  if (typeof saved === 'number') {
    state.lastSyncAt = saved;
  }
}

/** 订阅 reconcile 状态（立即回调一次当前值） */
export function onReconcileStatus(
  listener: (status: ReconcileStatus) => void
): () => void {
  statusListeners.add(listener);
  listener(state);
  return () => {
    statusListeners.delete(listener);
  };
}

/** 写入同步基线（pushToRemote/pullFromRemote 等手动路径共用） */
export async function setReconcileBaseline(ms: number): Promise<void> {
  state.lastSyncAt = ms;
  baselineLoaded = true;
  await kvStorageService.set(LAST_SYNC_KEY, ms).catch((error) => {
    console.warn('[Reconcile] 基线写入 kv 失败:', error);
  });
  notify();
}

export function getReconcileStatus(): ReconcileStatus {
  return state;
}

const VISIBLE_RECONCILE_THROTTLE_MS = 30_000;
let visibilityRegistered = false;

/**
 * 注册 visibilitychange 兜底 reconcile（幂等，应用级一次）：
 * - hidden：立即 reconcile（sweep 型变更与推送器失败重试的最终一致保证）
 * - visible：距上次同步超过 30s 才拉（多设备「切回即见」，Realtime 就绪前的兜底）
 */
export function registerVisibilityReconcile(): void {
  if (visibilityRegistered || typeof document === 'undefined') {
    return;
  }
  visibilityRegistered = true;
  document.addEventListener('visibilitychange', () => {
    if (!getSupabaseSyncConfig() || isSyncLockedNow()) {
      return;
    }
    if (document.visibilityState === 'hidden') {
      void reconcileFull().catch(() => undefined);
      return;
    }
    // visible：节流
    const now = Date.now();
    if (state.lastSyncAt === null || now - state.lastSyncAt > VISIBLE_RECONCILE_THROTTLE_MS) {
      void reconcileFull().catch(() => undefined);
    }
  });
}

/**
 * 等待首次登录 reconcile 完成（冷启动空态用）：
 * 返回 true=已完成一次全量/增量拉取；false=超时（离线或未触发）。
 * 已完成过则立即返回 true。
 */
export function waitForFirstReconcile(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      unsub();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsub = onReconcileStatus((s) => {
      if (!s.syncing && s.lastSyncAt !== null) {
        finish(true);
      }
    });
  });
}

/** 组装引擎依赖（每次调用读最新 config；lastSyncTime 实时取值防闭包过期） */
function buildDeps(config: SupabaseSyncConfig) {
  return {
    client: config.client,
    user: null as never, // 运行时填充
    collectLocal: collectLocalDataForSync,
    fetchRemote: async (
      _c: unknown,
      userId: string,
      options?: { sinceMs?: number | null }
    ) => {
      const { entities } = await fetchRemoteEntities(config, userId, options);
      return entities;
    },
    fetchRemoteKeys: async (_c: unknown, userId: string) => {
      return fetchRemoteEntityKeys(config, userId);
    },
    upsertRemote: async (
      _c: unknown,
      userId: string,
      entities: SyncEntity[]
    ) => upsertRemoteEntities(config, userId, entities),
    softDeleteRemote: async (_c: unknown, userId: string, keys: string[]) =>
      softDeleteRemoteEntities(config, userId, keys),
    applyRemote: async (opts: { entities: SyncEntity[] }) => {
      const { applied } = await applyRemoteEntities(opts.entities);
      return { applied };
    },
    deleteLocal: async (keys: string[]) => {
      const { deleted } = await deleteLocalEntities(keys);
      return { deleted };
    },
    resolveConflict: (
      _local: ReturnType<typeof toDiffInput>,
      _remote: ReturnType<typeof toDiffInput>,
      localEntity: SyncEntity,
      remoteEntity: SyncEntity
    ) => {
      // 画板元素级合并：先合并后上传
      if (
        localEntity.entity_type === 'board' &&
        remoteEntity.entity_type === 'board'
      ) {
        const { mergedBoard, hasConflicts } = mergeBoardElements(
          localEntity.content as never,
          remoteEntity.content as never
        );
        if (hasConflicts) {
          void applyRemoteEntities([{ ...remoteEntity, content: mergedBoard }]);
        }
      }
      return resolveBoardConflict(
        { updatedAt: localEntity.updated_at },
        { updatedAt: remoteEntity.updated_at }
      );
    },
    syncMedia: async (_c: unknown, userId: string) =>
      syncMediaToSupabase(config, userId),
  };
}

/**
 * 执行一次全量 reconcile。并发调用在互斥锁上排队；刚成功过（5s 内）的重复
 * 触发直接跳过，manual（force）绕过防抖。
 */
export async function reconcileFull(
  options: { force?: boolean } = {}
): Promise<SupabaseSyncResult> {
  const config = getSupabaseSyncConfig();
  if (!config) {
    return { ...emptyResult, error: '未登录，无法同步' };
  }
  await ensureBaseline();

  return runExclusiveSync(async () => {
    // 锁内复查防抖：排队中的重复触发在上一轮成功后直接跳过
    const now = Date.now();
    if (
      !options.force &&
      state.lastSyncAt !== null &&
      now - state.lastSyncAt < RECENT_GUARD_MS
    ) {
      return {
        ...emptyResult,
        success: true,
        duration: 0,
      };
    }

    state.syncing = true;
    notify();
    try {
      // 画布全量保存走防抖：同步前先落盘挂起保存，否则收集到旧快照
      await workspaceService
        .flushPendingCurrentBoardSave()
        .catch(() => undefined);
      const user = await getSupabaseSyncUser(config);
      if (!user) {
        return { ...emptyResult, error: '未能获取登录用户' };
      }

      // 同步前快照 outbox：成功后这些条目已随全量上云/墓碑化，出队防重复推送
      const outboxBefore = await listOutbox();

      const result = await runSync({
        ...buildDeps(config),
        user,
        lastSyncTime: state.lastSyncAt,
      });

      if (result.success) {
        await setReconcileBaseline(Date.now());
        await removeOutboxKeys(outboxBefore.map((entry) => entry.key));
        if (result.stageTimings) {
          console.info(
            '[SupabaseSync] stage timings:',
            `collect=${result.stageTimings.collectMs}ms`,
            `remoteFetch=${result.stageTimings.remoteFetchMs}ms`,
            `diff=${result.stageTimings.diffMs}ms`,
            `upload=${result.stageTimings.uploadMs}ms`,
            `download=${result.stageTimings.downloadMs}ms`,
            `total=${result.stageTimings.totalMs}ms`
          );
        }
      }
      return result;
    } finally {
      state.syncing = false;
      notify();
    }
  });
}
