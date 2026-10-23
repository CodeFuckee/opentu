/**
 * 云端直连运行时（openspec remove-local-persistence，flag cloud_only_storage=1 时
 * 取代「SyncPusher + reconcile」的传统接线）：
 * - Realtime（postgres_changes）→ 归一化变更事件 → cloudDirectStore.applyRemoteChanges
 * - Realtime 不可用/断线：退化为 60s 轻量键扫描轮询（与全量模式一致的兜底语义）
 *
 * 本模块不写本地存储——写路径由各存储服务的云端直连分支承担。
 */

import {
  getSupabaseSyncConfig,
  getSupabaseSyncUser,
  type RealtimeChannelLike,
} from './runtime';
import { cloudDirectStore, type RemoteEntityChange } from './cloud-direct-store';
import { fetchRemoteEntityKeys, entityKey } from './repository';
import type { SupabaseSyncConfig } from './types';

const POLL_INTERVAL_MS = 60_000;

let realtimeChannel: RealtimeChannelLike | null = null;
let realtimeJoined = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** postgres_changes 行载荷的最小结构面（supabase-js Realtime payload 子集） */
interface PostgresChangePayload {
  eventType?: string;
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

function parseRowTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function payloadToChange(
  payload: PostgresChangePayload
): RemoteEntityChange | null {
  const deleted = payload.eventType === 'DELETE';
  const row =
    (deleted ? payload.old : payload.new) ?? payload.old ?? payload.new;
  const entityType = row?.entity_type as string | undefined;
  const entityId = row?.entity_id as string | undefined;
  if (!entityType || !entityId) {
    return null;
  }
  const deletedAt = row?.deleted_at;
  const isTombstone =
    deleted ||
    (deletedAt !== null && deletedAt !== undefined && deletedAt !== '');
  return {
    entityType,
    entityId,
    updatedAt: isTombstone ? null : parseRowTimestamp(row?.updated_at),
  };
}

function startPollFallback(reason: string): void {
  if (pollTimer) {
    return;
  }
  console.info('[CloudDirect] Realtime 不可用，退化为 60s 键扫描轮询:', reason);
  pollTimer = setInterval(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
}

function stopPollFallback(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.info('[CloudDirect] Realtime 已连接，停止轮询兜底');
  }
}

/** 轻量键扫描：与缓存基线比对，差异部分转为变更事件 */
async function pollOnce(): Promise<void> {
  try {
    const config = getSupabaseSyncConfig();
    if (!config) {
      return;
    }
    const user = await getSupabaseSyncUser(config);
    if (!user) {
      return;
    }
    const { keys, error } = await fetchRemoteEntityKeys(config, user.id);
    if (error) {
      return;
    }
    const changes: RemoteEntityChange[] = [];
    const remoteKeys = new Set<string>();
    for (const key of keys) {
      remoteKeys.add(entityKey(key.entityType, key.entityId));
      changes.push({
        entityType: key.entityType,
        entityId: key.entityId,
        updatedAt: key.deletedAt ? null : key.updatedAt,
      });
    }
    // 缓存里有而云端键扫描没有的 → 已被真删除
    for (const cachedKey of cloudDirectStore.getKnownKeys()) {
      if (!remoteKeys.has(cachedKey)) {
        const separator = cachedKey.indexOf(':');
        changes.push({
          entityType: cachedKey.slice(0, separator),
          entityId: cachedKey.slice(separator + 1),
          updatedAt: null,
        });
      }
    }
    cloudDirectStore.applyRemoteChanges(changes);
  } catch {
    // 轮询失败静默，下个周期再试
  }
}

async function startRealtime(config: SupabaseSyncConfig): Promise<void> {
  if (realtimeChannel) {
    return;
  }
  try {
    const user = await getSupabaseSyncUser(config);
    if (!user) {
      startPollFallback('未获取到登录用户');
      return;
    }
    const client = config.client as {
      channel: (name: string) => RealtimeChannelLike['channelLike'];
      removeChannel: (channel: unknown) => Promise<unknown>;
    };
    const channel = client.channel('user-sync-direct');
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_sync_data',
        filter: `user_id=eq.${user.id}`,
      },
      (payload?: unknown) => {
        const change = payloadToChange(
          (payload ?? {}) as PostgresChangePayload
        );
        if (change) {
          cloudDirectStore.applyRemoteChanges([change]);
        }
      }
    );
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        realtimeJoined = true;
        stopPollFallback();
      } else {
        realtimeJoined = false;
        startPollFallback(`channel status=${status}`);
      }
    });
    realtimeChannel = {
      channelLike: channel,
      unsubscribe: () => client.removeChannel(channel),
    };
  } catch (error) {
    console.warn('[CloudDirect] Realtime 订阅失败，使用轮询兜底:', error);
    startPollFallback('subscribe failed');
  }
}

export async function stopCloudDirectRuntime(): Promise<void> {
  stopPollFallback();
  if (realtimeChannel) {
    void realtimeChannel.unsubscribe().catch(() => undefined);
    realtimeChannel = null;
  }
  realtimeJoined = false;
}

/** 登录/启动时接通云端直连运行时（幂等） */
export async function startCloudDirectRuntime(
  config: SupabaseSyncConfig
): Promise<void> {
  await startRealtime(config);
  if (!realtimeJoined) {
    startPollFallback('初始订阅未就绪');
  }
}
