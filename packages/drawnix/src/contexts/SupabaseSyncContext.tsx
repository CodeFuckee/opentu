/**
 * Supabase 云同步 Context（refactor-cloud-native-sync Phase B）
 *
 * 写入上云主路径：SyncPusher 事件驱动推送（ChangeBus → Outbox → 定向收集 → upsert），
 * 本 Context 负责装配与兜底：
 * - 登录后全量 reconcile 一次（增量窗口）
 * - 切后台且有待推送变更时全量 reconcile（保证 sweep 型变更最终一致）
 * - 手动「立即同步 / 上传 / 下载」保留为救急入口
 * - 向 UI 暴露同步状态与待推送数量（徽标）
 */

import React, {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { workspaceService } from '../services/workspace-service';
import { getSupabaseSyncConfig } from '../services/supabase-sync/runtime';
import { runSync } from '../services/supabase-sync/sync-engine';
import { collectLocalDataForSync } from '../services/supabase-sync/local-collector';
import {
  fetchRemoteEntities,
  fetchRemoteEntityKeys,
  upsertRemoteEntities,
  softDeleteRemoteEntities,
} from '../services/supabase-sync/repository';
import { syncMediaToSupabase } from '../services/supabase-sync/media-sync';
import { applyRemoteEntities } from '../services/supabase-sync/apply-remote';
import { deleteLocalEntities } from '../services/supabase-sync/delete-local';
import {
  mergeBoardElements,
  resolveBoardConflict,
  toDiffInput,
} from '../services/supabase-sync/merge';
import { kvStorageService } from '../services/kv-storage-service';
import {
  syncPusher,
  ensureSyncInfraStarted,
} from '../services/supabase-sync/sync-pusher';
import { listOutbox, removeOutboxKeys } from '../services/supabase-sync/outbox';
import { runExclusiveSync, isSyncLocked } from '../services/supabase-sync/sync-mutex';
import type {
  SupabaseSyncStatus,
  SupabaseSyncResult,
  SyncEntity,
} from '../services/supabase-sync/types';
import type { SupabaseSyncDeps } from '../services/supabase-sync/sync-engine';
import { entityKey, parseEntityKey } from '../services/supabase-sync/checksum';
import { logInfo, logError, logSuccess } from '../services/supabase-sync/log';

const LAST_SYNC_KEY = 'supabase_sync_last_sync';

interface SupabaseSyncContextValue {
  /** 是否已注册（已登录） */
  isConfigured: boolean;
  syncStatus: SupabaseSyncStatus;
  isSyncing: boolean;
  lastSyncTime: number | null;
  error: string | null;
  /** outbox 待推送条数（事件驱动推送队列） */
  pendingSyncCount: number;
  /** 浏览器离线（待推送变更将积压到恢复在线） */
  offline: boolean;
  /** 立即双向同步 */
  sync: () => Promise<SupabaseSyncResult>;
  /** 以本地为准（上传） */
  pushToRemote: () => Promise<SupabaseSyncResult>;
  /** 以远程为准（下载） */
  pullFromRemote: () => Promise<SupabaseSyncResult>;
}

const SupabaseSyncContext = createContext<SupabaseSyncContextValue | null>(
  null
);

const emptyResult: SupabaseSyncResult = {
  success: false,
  uploaded: 0,
  downloaded: 0,
  deleted: 0,
  conflicts: 0,
  duration: 0,
  error: 'Supabase Sync context is unavailable',
};

interface SupabaseSyncProviderProps {
  children: React.ReactNode;
}

export function SupabaseSyncProvider({ children }: SupabaseSyncProviderProps) {
  const [isConfigured, setIsConfigured] = useState(false);
  const [syncStatus, setSyncStatus] =
    useState<SupabaseSyncStatus>('not_configured');
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [offline, setOffline] = useState(
    typeof navigator === 'undefined' ? false : navigator.onLine === false
  );

  const syncRef = useRef<{ last: number | null }>({ last: null });
  const initializedRef = useRef(false);

  /** 构建 sync deps（每次调用时读取最新 config） */
  const buildDeps = useCallback((): SupabaseSyncDeps | null => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return null;
    }
    const client = config.client;
    return {
      client,
      user: null as never, // 运行时填充
      collectLocal: collectLocalDataForSync,
      fetchRemote: async (
        c: unknown,
        userId: string,
        options?: { sinceMs?: number | null }
      ) => {
        const { entities } = await fetchRemoteEntities(config, userId, options);
        return entities;
      },
      fetchRemoteKeys: async (c: unknown, userId: string) => {
        return fetchRemoteEntityKeys(config, userId);
      },
      upsertRemote: async (
        c: unknown,
        userId: string,
        entities: SyncEntity[]
      ) => upsertRemoteEntities(config, userId, entities),
      softDeleteRemote: async (c: unknown, userId: string, keys: string[]) =>
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
        local: ReturnType<typeof toDiffInput>,
        remote: ReturnType<typeof toDiffInput>,
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
            // 合并结果保留本地 updatedAt 较大值；写回本地并上传
            void applyRemoteEntities([
              { ...remoteEntity, content: mergedBoard },
            ]);
          }
        }
        return resolveBoardConflict(
          { updatedAt: localEntity.updated_at },
          { updatedAt: remoteEntity.updated_at }
        );
      },
      syncMedia: async (c: unknown, userId: string) =>
        syncMediaToSupabase(config, userId),
      // 增量窗口（openspec improve-sync-performance）：syncRef 实时取值避免
      // useCallback 空依赖闭包过期；null = 首同步全量
      lastSyncTime: syncRef.current.last,
    };
  }, []);

  /** 全量 reconcile（登录/切后台/手动）：与事件驱动推送共享互斥锁 */
  const performSync = useCallback(async (): Promise<SupabaseSyncResult> => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return { ...emptyResult, error: '未登录，无法同步' };
    }

    setIsSyncing(true);
    setSyncStatus('syncing');

    try {
      // 同步前快照 outbox：成功后这些条目的内容已随全量 reconcile 上云/墓碑化，
      // 出队避免推送器重复上传；同步期间新入队的条目不受影响
      const outboxBefore = await listOutbox();

      // 画布全量保存走防抖：上传前先把挂起保存落盘，否则收集到旧快照
      await workspaceService
        .flushPendingCurrentBoardSave()
        .catch(() => undefined);
      // 获取当前用户
      const client = config.client as {
        auth: {
          getSession: () => Promise<{
            data: {
              session: { user: { id: string; email?: string } | null } | null;
            };
          }>;
        };
      };
      const { data } = await client.auth.getSession();
      const user = data.session?.user;
      if (!user) {
        setSyncStatus('error');
        setError('未能获取登录用户');
        return { ...emptyResult, error: '未能获取登录用户' };
      }

      const deps = buildDeps();
      if (!deps) {
        setSyncStatus('error');
        return { ...emptyResult, error: '同步未配置' };
      }

      logInfo('开始 Supabase 云同步', { userId: user.id });
      const result = await runExclusiveSync(() =>
        runSync({
          ...deps,
          user: { id: user.id, email: user.email },
        })
      );

      syncRef.current.last = Date.now();
      setLastSyncTime(syncRef.current.last);
      await kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);

      if (result.success) {
        setError(null);
        await removeOutboxKeys(outboxBefore.map((entry) => entry.key));
        setPendingSyncCount(await syncPusher.pendingCount());
        // 阶段耗时（openspec improve-sync-performance）：性能观测与回归对比
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
        logSuccess('云同步完成', {
          uploaded: result.uploaded,
          downloaded: result.downloaded,
          deleted: result.deleted,
          conflicts: result.conflicts,
        });
      } else {
        setSyncStatus('error');
        setError(result.error ?? '同步失败');
        logError(
          '云同步失败',
          result.error ? new Error(result.error) : new Error('同步失败')
        );
      }
      return result;
    } catch (err) {
      setSyncStatus('error');
      setError(err instanceof Error ? err.message : '同步失败');
      logError(
        '云同步异常',
        err instanceof Error ? err : new Error(String(err))
      );
      return {
        ...emptyResult,
        error: err instanceof Error ? err.message : '同步失败',
      };
    } finally {
      setIsSyncing(false);
    }
  }, [buildDeps]);

  /** 初始化：接线写点 + 推送器 + 登录后全量 reconcile */
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // 写点接线 + 推送器（幂等；主应用挂载时已启动，这里兜底弹窗独立打开场景）
    ensureSyncInfraStarted();
    const unsubPusherStatus = syncPusher.onStatus((status) => {
      setPendingSyncCount(status.pending);
      setOffline(!status.online);
      if (!status.syncing && status.pending > 0) {
        setSyncStatus((prev) =>
          prev === 'syncing' || prev === 'error' ? prev : 'local_changes'
        );
      } else if (!status.syncing && status.pending === 0) {
        setSyncStatus((prev) => (prev === 'local_changes' ? 'synced' : prev));
      }
    });

    const init = async () => {
      const saved = await kvStorageService
        .get<number>(LAST_SYNC_KEY)
        .catch(() => null);
      if (typeof saved === 'number') {
        syncRef.current.last = saved;
        setLastSyncTime(saved);
      }
      // 已注册配置（宿主登录后）→ 全量 reconcile 一次
      if (getSupabaseSyncConfig()) {
        setIsConfigured(true);
        setSyncStatus('synced');
        scheduleAutoSync(0);
      }
    };
    init();

    // 轮询检查配置是否已注册（宿主登录异步发生）
    const configPoll = setInterval(() => {
      if (getSupabaseSyncConfig()) {
        setIsConfigured((configured) => {
          if (!configured) {
            scheduleAutoSync(0);
          }
          return true;
        });
        clearInterval(configPoll);
      }
    }, 500);
    const pollRef = { timer: configPoll };

    // 切回前台节流拉取：多设备工作流的高频路径是「在设备 A 建数据 → 切回设备 B」，
    // Realtime（Phase D）就绪前靠这里保证切回即见（30s 节流防频繁切 tab 打爆云端）
    let lastVisibleSyncAt = 0;
    const handleVisibilityChange = () => {
      if (!getSupabaseSyncConfig() || isSyncLocked()) {
        return;
      }
      if (document.visibilityState === 'hidden') {
        // 切后台兜底全量 reconcile：sweep 型变更与推送器失败重试在此获得最终一致保证
        performSync().catch(() => {
          // 静默：visibilitychange 触发的同步失败不影响主流程
        });
        return;
      }
      // visible：距上次同步超过 30s 才拉，避免频繁切换反复 reconcile
      const now = Date.now();
      if (now - lastVisibleSyncAt > 30_000) {
        lastVisibleSyncAt = now;
        performSync().catch(() => {
          // 静默
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(pollRef.timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      unsubPusherStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 登录后的初始全量 reconcile */
  const scheduleAutoSync = useCallback((delay: number) => {
    setTimeout(() => {
      performSyncRef.current?.().catch(() => {
        // 静默：初始同步失败不影响使用（切后台/手动可再触发）
      });
    }, delay);
  }, []);

  // scheduleAutoSync 定义在 effect 之后但 effect 首帧即可能调用：
  // 经 ref 转发避免 use-before-declare 与闭包过期
  const performSyncRef = useRef<(() => Promise<SupabaseSyncResult>) | null>(
    null
  );
  useEffect(() => {
    performSyncRef.current = performSync;
  }, [performSync]);

  /** 立即同步 */
  const sync = useCallback(async () => performSync(), [performSync]);

  /** 上传（以本地为准）：强制 lastSyncTime=0 比较以触发上传 */
  const pushToRemote = useCallback(async (): Promise<SupabaseSyncResult> => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return { ...emptyResult, error: '未登录，无法同步' };
    }
    const client = config.client as {
      auth: {
        getSession: () => Promise<{
          data: { session: { user: { id: string } | null } | null };
        }>;
      };
    };
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      return { ...emptyResult, error: '未能获取登录用户' };
    }
    // 用 lastSyncTime=0 强制本地全量视为变更
    const deps = buildDeps();
    if (!deps) {
      return { ...emptyResult, error: '同步未配置' };
    }
    setIsSyncing(true);
    setSyncStatus('syncing');
    let result: SupabaseSyncResult;
    try {
      const outboxBefore = await listOutbox();
      // 上传前落盘挂起的画布保存（同 performSync）
      await workspaceService
        .flushPendingCurrentBoardSave()
        .catch(() => undefined);
      result = await runExclusiveSync(() =>
        runSync({
          ...deps,
          user: { id: user.id },
          lastSyncTime: 0,
          applyRemote: async () => ({ applied: 0 }),
          syncMedia: undefined,
        })
      );
      if (result.success) {
        // 同步更新 syncRef 基线（buildDeps 从 syncRef 取值），否则下次自动同步
        // 仍用旧基线比对，制造大量假冲突
        syncRef.current.last = Date.now();
        setLastSyncTime(syncRef.current.last);
        await kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);
        await removeOutboxKeys(outboxBefore.map((entry) => entry.key));
        setPendingSyncCount(await syncPusher.pendingCount());
      }
      setSyncStatus(result.success ? 'synced' : 'error');
      setError(result.error ?? null);
    } finally {
      setIsSyncing(false);
    }
    return result;
  }, [buildDeps]);

  /** 下载（以远程为准）：强制远程视为较新 */
  const pullFromRemote = useCallback(async (): Promise<SupabaseSyncResult> => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return { ...emptyResult, error: '未登录，无法同步' };
    }
    const client = config.client as {
      auth: {
        getSession: () => Promise<{
          data: { session: { user: { id: string } | null } | null };
        }>;
      };
    };
    const { data } = await client.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      return { ...emptyResult, error: '未能获取登录用户' };
    }
    setIsSyncing(true);
    setSyncStatus('syncing');
    try {
      await workspaceService
        .flushPendingCurrentBoardSave()
        .catch(() => undefined);
      const applied = await runExclusiveSync(async () => {
        const remote = await fetchRemoteEntities(config, user.id);
        // 拆分：有效实体 → 应用下载；墓碑实体（deleted_at 非空）→ 本地删除，
        // 保证「下载远程」与「立即同步」的画板数量语义一致（墓碑不复活、生效删除）
        const activeEntities = remote.entities.filter((e) => !e.deleted_at);
        const tombstoneKeys = remote.entities
          .filter((e) => !!e.deleted_at)
          .map((e) => entityKey(e.entity_type, e.entity_id));
        const { applied: count, failed } = await applyRemoteEntities(
          activeEntities
        );
        if (failed.length > 0) {
          // 失败实体此前被静默丢弃，留痕便于排查（是否重试/影响基线推进属
          // 行为语义变更，另行决策）
          console.warn(
            '[SupabaseSync] applyRemoteEntities failed entities:',
            failed
          );
        }
        let deleted = 0;
        if (tombstoneKeys.length > 0) {
          const { deleted: tombstoneDeleted } = await deleteLocalEntities(
            tombstoneKeys
          );
          deleted = tombstoneDeleted;
        }
        return { applied: count, deleted };
      });
      // 同步更新 syncRef 基线（同 pushToRemote）
      syncRef.current.last = Date.now();
      setLastSyncTime(syncRef.current.last);
      await kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);
      setSyncStatus('synced');
      setError(null);
      return {
        success: true,
        uploaded: 0,
        downloaded: applied.applied,
        deleted: applied.deleted,
        conflicts: 0,
        duration: 0,
      };
    } finally {
      setIsSyncing(false);
    }
  }, []);

  const value: SupabaseSyncContextValue = {
    isConfigured,
    syncStatus,
    isSyncing,
    lastSyncTime,
    error,
    pendingSyncCount,
    offline,
    sync,
    pushToRemote,
    pullFromRemote,
  };

  return (
    <SupabaseSyncContext.Provider value={value}>
      {children}
    </SupabaseSyncContext.Provider>
  );
}

export function useSupabaseSync(): SupabaseSyncContextValue {
  const context = useContext(SupabaseSyncContext);
  if (!context) {
    throw new Error(
      'useSupabaseSync must be used within a SupabaseSyncProvider'
    );
  }
  return context;
}

export function useSupabaseSyncOptional(): SupabaseSyncContextValue | null {
  return useContext(SupabaseSyncContext);
}

export { entityKey, parseEntityKey };
