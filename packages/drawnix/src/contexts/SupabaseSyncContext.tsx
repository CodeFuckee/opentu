/**
 * Supabase 云同步 Context
 *
 * 替代 GitHubSyncContext：登录 Supabase 后自动同步 + 手动同步控制。
 * - 登录态由宿主（apps/web auth-context）通过 configureSupabaseSync 注册
 * - 登录后首次自动全量上传本地（云端无记录时）或增量合并
 * - 提供手动「立即同步 / 上传 / 下载」按钮
 * - workspace 变更通过 workspaceService.observeEvents 标记待同步
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
  upsertRemoteEntities,
  softDeleteRemoteEntities,
} from '../services/supabase-sync/repository';
import { syncMediaToSupabase } from '../services/supabase-sync/media-sync';
import { applyRemoteEntities } from '../services/supabase-sync/apply-remote';
import { deleteLocalEntities } from '../services/supabase-sync/delete-local';
import { mergeBoardElements, resolveBoardConflict, toDiffInput } from '../services/supabase-sync/merge';
import { kvStorageService } from '../services/kv-storage-service';
import type { SupabaseSyncStatus, SupabaseSyncResult, SyncEntity } from '../services/supabase-sync/types';
import type { SupabaseSyncDeps } from '../services/supabase-sync/sync-engine';
import { entityKey, parseEntityKey } from '../services/supabase-sync/checksum';
import { logInfo, logError, logSuccess } from '../services/supabase-sync/log';

const LAST_SYNC_KEY = 'supabase_sync_last_sync';
const AUTO_SYNC_DEBOUNCE_MS = 30000;

interface SupabaseSyncContextValue {
  /** 是否已注册（已登录） */
  isConfigured: boolean;
  syncStatus: SupabaseSyncStatus;
  isSyncing: boolean;
  lastSyncTime: number | null;
  error: string | null;
  /** 立即双向同步 */
  sync: () => Promise<SupabaseSyncResult>;
  /** 以本地为准（上传） */
  pushToRemote: () => Promise<SupabaseSyncResult>;
  /** 以远程为准（下载） */
  pullFromRemote: () => Promise<SupabaseSyncResult>;
}

const SupabaseSyncContext = createContext<SupabaseSyncContextValue | null>(null);

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
  const [syncStatus, setSyncStatus] = useState<SupabaseSyncStatus>('not_configured');
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncRef = useRef<{ inProgress: boolean; last: number | null }>({
    inProgress: false,
    last: null,
  });
  const autoSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingChangesRef = useRef(false);
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
      fetchRemote: async (c: unknown, userId: string) => {
        const { entities } = await fetchRemoteEntities(config, userId);
        return entities;
      },
      upsertRemote: async (c: unknown, userId: string, entities: SyncEntity[]) =>
        upsertRemoteEntities(config, userId, entities),
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
            void applyRemoteEntities([{ ...remoteEntity, content: mergedBoard }]);
          }
        }
        return resolveBoardConflict(
          { updatedAt: localEntity.updated_at },
          { updatedAt: remoteEntity.updated_at }
        );
      },
      syncMedia: async (c: unknown, userId: string) =>
        syncMediaToSupabase(config, userId),
      lastSyncTime: syncRef.current.last,
    };
  }, []);

  /** 执行同步（内部用当前 config） */
  const performSync = useCallback(
    async (): Promise<SupabaseSyncResult> => {
      if (syncRef.current.inProgress) {
        return { ...emptyResult, error: '同步正在进行中' };
      }
      const config = getSupabaseSyncConfig();
      if (!config) {
        return { ...emptyResult, error: '未登录，无法同步' };
      }

      syncRef.current.inProgress = true;
      setIsSyncing(true);
      setSyncStatus('syncing');

      try {
        // 获取当前用户
        const client = config.client as {
          auth: {
            getSession: () => Promise<{
              data: { session: { user: { id: string; email?: string } | null } | null };
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
        const result = await runSync({
          ...deps,
          user: { id: user.id, email: user.email },
        });

        syncRef.current.last = Date.now();
        setLastSyncTime(syncRef.current.last);
        await kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);

        if (result.success) {
          setSyncStatus('synced');
          setError(null);
          pendingChangesRef.current = false;
          logSuccess('云同步完成', {
            uploaded: result.uploaded,
            downloaded: result.downloaded,
            deleted: result.deleted,
            conflicts: result.conflicts,
          });
        } else {
          setSyncStatus('error');
          setError(result.error ?? '同步失败');
          logError('云同步失败', result.error ? new Error(result.error) : new Error('同步失败'));
        }
        return result;
      } catch (err) {
        setSyncStatus('error');
        setError(err instanceof Error ? err.message : '同步失败');
        logError('云同步异常', err instanceof Error ? err : new Error(String(err)));
        return { ...emptyResult, error: err instanceof Error ? err.message : '同步失败' };
      } finally {
        syncRef.current.inProgress = false;
        setIsSyncing(false);
      }
    },
    [buildDeps]
  );

  /** 初始化：读取上次同步时间 + 注册状态监听 */
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    const init = async () => {
      const saved = await kvStorageService.get<number>(LAST_SYNC_KEY).catch(() => null);
      if (typeof saved === 'number') {
        syncRef.current.last = saved;
        setLastSyncTime(saved);
      }
      // 已注册配置（宿主登录后）→ 自动同步
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
        if (!isConfigured) {
          setIsConfigured(true);
          scheduleAutoSync(0);
        }
        clearInterval(configPoll);
      }
    }, 500);
    const pollRef = { timer: configPoll };

    // workspace 变更 → 标记待同步 + 防抖自动同步
    const workspaceSubscription = workspaceService
      .observeEvents()
      .subscribe((event: { type: string }) => {
        const syncTriggerEvents = ['boardCreated', 'boardUpdated', 'boardDeleted', 'folderCreated', 'folderUpdated', 'folderDeleted'];
        if (!syncTriggerEvents.includes(event.type)) {
          return;
        }
        if (!getSupabaseSyncConfig()) {
          return;
        }
        pendingChangesRef.current = true;
        setSyncStatus('local_changes');
        scheduleAutoSync(AUTO_SYNC_DEBOUNCE_MS);
      });

    const handleVisibilityChange = () => {
      if (
        document.visibilityState === 'hidden' &&
        getSupabaseSyncConfig() &&
        pendingChangesRef.current &&
        !syncRef.current.inProgress
      ) {
        performSync().catch(() => {
          // 静默：visibilitychange 触发的同步失败不影响主流程
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(pollRef.timer);
      workspaceSubscription.unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 防抖自动同步 */
  const scheduleAutoSync = useCallback(
    (delay: number) => {
      if (autoSyncTimerRef.current) {
        clearTimeout(autoSyncTimerRef.current);
      }
      autoSyncTimerRef.current = setTimeout(() => {
        performSync().catch(() => {
          // 静默：防抖自动同步失败不影响使用
        });
      }, delay);
    },
    [performSync]
  );

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
    // 与 performSync 相同的互斥守卫：防止与 30s 自动同步、visibilitychange
    // 同步并发运行，交错写本地存储与云端
    if (syncRef.current.inProgress) {
      return { ...emptyResult, error: '同步正在进行中' };
    }
    syncRef.current.inProgress = true;
    let result: SupabaseSyncResult;
    try {
      result = await runSync({
        ...deps,
        user: { id: user.id },
        lastSyncTime: 0,
        applyRemote: async () => ({ applied: 0 }),
        syncMedia: undefined,
      });
      // 同步更新 syncRef 基线（buildDeps 从 syncRef 取值），否则下次自动同步
      // 仍用旧基线比对，制造大量假冲突
      syncRef.current.last = Date.now();
      setLastSyncTime(syncRef.current.last);
      void kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);
      setSyncStatus(result.success ? 'synced' : 'error');
      setError(result.error ?? null);
    } finally {
      syncRef.current.inProgress = false;
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
    // 与 performSync 相同的互斥守卫（同 pushToRemote）
    if (syncRef.current.inProgress) {
      return { ...emptyResult, error: '同步正在进行中' };
    }
    syncRef.current.inProgress = true;
    try {
      const remote = await fetchRemoteEntities(config, user.id);
      // 拆分：有效实体 → 应用下载；墓碑实体（deleted_at 非空）→ 本地删除，
      // 保证「下载远程」与「立即同步」的画板数量语义一致（墓碑不复活、生效删除）
      const activeEntities = remote.entities.filter((e) => !e.deleted_at);
      const tombstoneKeys = remote.entities
        .filter((e) => !!e.deleted_at)
        .map((e) => entityKey(e.entity_type, e.entity_id));
      const { applied } = await applyRemoteEntities(activeEntities);
      let deleted = 0;
      if (tombstoneKeys.length > 0) {
        const { deleted: tombstoneDeleted } = await deleteLocalEntities(tombstoneKeys);
        deleted = tombstoneDeleted;
      }
      // 同步更新 syncRef 基线（同 pushToRemote）
      syncRef.current.last = Date.now();
      setLastSyncTime(syncRef.current.last);
      void kvStorageService.set(LAST_SYNC_KEY, syncRef.current.last);
      setSyncStatus('synced');
      setError(null);
      return {
        success: true,
        uploaded: 0,
        downloaded: applied,
        deleted,
        conflicts: 0,
        duration: 0,
      };
    } finally {
      syncRef.current.inProgress = false;
    }
  }, []);

  const value: SupabaseSyncContextValue = {
    isConfigured,
    syncStatus,
    isSyncing,
    lastSyncTime,
    error,
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
    throw new Error('useSupabaseSync must be used within a SupabaseSyncProvider');
  }
  return context;
}

export function useSupabaseSyncOptional(): SupabaseSyncContextValue | null {
  return useContext(SupabaseSyncContext);
}

export { entityKey, parseEntityKey };