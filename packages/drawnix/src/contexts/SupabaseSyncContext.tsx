/**
 * Supabase 云同步 Context（refactor-cloud-native-sync Phase C）
 *
 * 同步执行已全部提取到模块层（reconcile.ts / sync-pusher.ts / infra.ts），
 * 由登录态（configureSupabaseSync）与主应用挂载（ensureSyncInfraStarted）驱动，
 * 不再依赖本 Provider 挂载。本 Context 只做 UI 装配：状态订阅 + 手动救急操作
 * （立即同步 / 上传 / 下载）。同步设置弹窗经 DeferredSyncSettings 提供本 Provider。
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
import {
  getSupabaseSyncConfig,
  getSupabaseSyncUser,
} from '../services/supabase-sync/runtime';
import { runSync } from '../services/supabase-sync/sync-engine';
import {
  collectLocalDataForSync,
} from '../services/supabase-sync/local-collector';
import {
  fetchRemoteEntities,
  fetchRemoteEntityKeys,
  upsertRemoteEntities,
  softDeleteRemoteEntities,
} from '../services/supabase-sync/repository';
import { applyRemoteEntities } from '../services/supabase-sync/apply-remote';
import { deleteLocalEntities } from '../services/supabase-sync/delete-local';
import {
  mergeBoardElements,
  resolveBoardConflict,
} from '../services/supabase-sync/merge';
import { listOutbox, removeOutboxKeys } from '../services/supabase-sync/outbox';
import { runExclusiveSync } from '../services/supabase-sync/sync-mutex';
import {
  syncPusher,
  ensureSyncInfraStarted,
} from '../services/supabase-sync/sync-pusher';
import {
  reconcileFull,
  setReconcileBaseline,
  onReconcileStatus,
} from '../services/supabase-sync/reconcile';
import type {
  SupabaseSyncStatus,
  SupabaseSyncResult,
  SyncEntity,
} from '../services/supabase-sync/types';
import { entityKey, parseEntityKey } from '../services/supabase-sync/checksum';
import { logError, logSuccess } from '../services/supabase-sync/log';

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
  const [isConfigured, setIsConfigured] = useState(
    () => Boolean(getSupabaseSyncConfig())
  );
  const [syncStatus, setSyncStatus] =
    useState<SupabaseSyncStatus>('not_configured');
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [offline, setOffline] = useState(
    typeof navigator === 'undefined' ? false : navigator.onLine === false
  );

  const initializedRef = useRef(false);

  /** 初始化：订阅模块层状态 + 登录态轮询 */
  useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // 基础设施兜底启动（主应用已启动过则幂等跳过）
    ensureSyncInfraStarted();

    // 全量 reconcile 状态 → React 状态
    const unsubReconcile = onReconcileStatus((status) => {
      setIsSyncing(status.syncing);
      setLastSyncTime(status.lastSyncAt);
      if (status.syncing) {
        setSyncStatus('syncing');
      } else {
        setSyncStatus((prev) =>
          prev === 'syncing' || prev === 'error' ? 'synced' : prev
        );
      }
    });

    // 事件驱动推送器状态 → 待推送徽标
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

    // 登录态由宿主异步注册，轮询跟进
    const poll = setInterval(() => {
      setIsConfigured(Boolean(getSupabaseSyncConfig()));
    }, 1000);

    return () => {
      unsubReconcile();
      unsubPusherStatus();
      clearInterval(poll);
    };
  }, []);

  /** 立即双向同步（force 绕过防抖窗口） */
  const sync = useCallback(async (): Promise<SupabaseSyncResult> => {
    const result = await reconcileFull({ force: true });
    if (result.success) {
      setError(null);
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
  }, []);

  /** 上传（以本地为准）：强制 lastSyncTime=0 比较以触发全量上传 */
  const pushToRemote = useCallback(async (): Promise<SupabaseSyncResult> => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return { ...emptyResult, error: '未登录，无法同步' };
    }
    const user = await getSupabaseSyncUser(config);
    if (!user) {
      return { ...emptyResult, error: '未能获取登录用户' };
    }
    setIsSyncing(true);
    setSyncStatus('syncing');
    let result: SupabaseSyncResult;
    try {
      const outboxBefore = await listOutbox();
      // 上传前落盘挂起的画布保存
      await workspaceService
        .flushPendingCurrentBoardSave()
        .catch(() => undefined);
      result = await runExclusiveSync(() =>
        runSync({
          client: config.client,
          user,
          lastSyncTime: 0,
          applyRemote: async () => ({ applied: 0 }),
          syncMedia: undefined,
          collectLocal: collectLocalDataForSync,
          fetchRemote: async (_c, userId, options) => {
            const { entities } = await fetchRemoteEntities(
              config,
              userId,
              options
            );
            return entities;
          },
          fetchRemoteKeys: async (_c, userId) =>
            fetchRemoteEntityKeys(config, userId),
          upsertRemote: async (_c, userId, entities) =>
            upsertRemoteEntities(config, userId, entities),
          softDeleteRemote: async (_c, _userId, _keys) => ({}),
          resolveConflict: (
            _local,
            _remote,
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
        })
      );
      if (result.success) {
        // 基线推进（模块层共享），否则下次自动同步仍用旧基线制造大量假冲突
        await setReconcileBaseline(Date.now());
        await removeOutboxKeys(outboxBefore.map((entry) => entry.key));
      }
      setSyncStatus(result.success ? 'synced' : 'error');
      setError(result.error ?? null);
    } finally {
      setIsSyncing(false);
    }
    return result;
  }, []);

  /** 下载（以远程为准）：强制远程视为较新 */
  const pullFromRemote = useCallback(async (): Promise<SupabaseSyncResult> => {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return { ...emptyResult, error: '未登录，无法同步' };
    }
    const user = await getSupabaseSyncUser(config);
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
      await setReconcileBaseline(Date.now());
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
