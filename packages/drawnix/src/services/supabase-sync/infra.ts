/**
 * 同步基础设施生命周期（openspec refactor-cloud-native-sync Phase C+D）
 *
 * 宿主登录/登出时经 runtime.configureSupabaseSync → handleConfigChanged 进到这里：
 * - 登录：接好写点与推送器 → 订阅 Realtime（postgres_changes）→ 登录全量 reconcile
 * - 登出：退订 Realtime、停推送器、清推送队列与同步基线（下次登录走全量；
 *   本地缓存数据的彻底清理属行为变更，另行评审——当前保持「登出不清缓存」）
 *
 * Realtime 不可用（自托管未启用/断线/HTTP 兼容问题）时退化为 60s 增量轮询，
 * 保证多设备最终一致（Phase D.3）。
 */

import {
  getSupabaseSyncUser,
  type RealtimeChannelLike,
} from './runtime';
import { installSyncWritePointWiring } from './write-point-wiring';
import { syncPusher } from './sync-pusher';
import { reconcileFull, LAST_SYNC_KEY } from './reconcile';
import { clearOutbox } from './outbox';
import { kvStorageService } from '../kv-storage-service';
import type { SupabaseSyncConfig } from './types';

const REALTIME_DEBOUNCE_MS = 2000;
const REALTIME_MIN_INTERVAL_MS = 5000;
const POLL_INTERVAL_MS = 60_000;

let realtimeChannel: RealtimeChannelLike | null = null;
let realtimeJoined = false;
let realtimeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastRealtimeReconcileAt = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/** Realtime 事件 → 节流 reconcile（增量窗口，成本低） */
function scheduleRealtimeReconcile(): void {
  if (realtimeDebounceTimer) {
    clearTimeout(realtimeDebounceTimer);
  }
  realtimeDebounceTimer = setTimeout(() => {
    realtimeDebounceTimer = null;
    const now = Date.now();
    if (now - lastRealtimeReconcileAt < REALTIME_MIN_INTERVAL_MS) {
      return;
    }
    lastRealtimeReconcileAt = now;
    void reconcileFull().catch(() => {
      // 静默：Realtime 触发的同步失败留给轮询兜底
    });
  }, REALTIME_DEBOUNCE_MS);
}

function startPollFallback(reason: string): void {
  if (pollTimer) {
    return;
  }
  console.info('[SupabaseSync] Realtime 不可用，退化为 60s 轮询:', reason);
  pollTimer = setInterval(() => {
    if (getPollEnabled()) {
      void reconcileFull().catch(() => undefined);
    }
  }, POLL_INTERVAL_MS);
}

function stopPollFallback(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.info('[SupabaseSync] Realtime 已连接，停止轮询兜底');
  }
}

// 轮询启停判断需要读到 channel 状态（模块内变量直读）
function getPollEnabled(): boolean {
  return !realtimeJoined;
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
    const channel = client.channel('user-sync');
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'user_sync_data',
        filter: `user_id=eq.${user.id}`,
      },
      () => scheduleRealtimeReconcile()
    );
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        realtimeJoined = true;
        stopPollFallback();
      } else {
        // CHANNEL_ERROR / TIMED_OUT / CLOSED → 轮询兜底
        realtimeJoined = false;
        if (status !== 'SUBSCRIBED') {
          startPollFallback(`channel status=${status}`);
        }
      }
    });
    realtimeChannel = { channelLike: channel, unsubscribe: () => client.removeChannel(channel) };
  } catch (error) {
    console.warn('[SupabaseSync] Realtime 订阅失败，使用轮询兜底:', error);
    startPollFallback('subscribe failed');
  }
}

function stopRealtime(): void {
  if (realtimeDebounceTimer) {
    clearTimeout(realtimeDebounceTimer);
    realtimeDebounceTimer = null;
  }
  stopPollFallback();
  if (realtimeChannel) {
    void realtimeChannel.unsubscribe().catch(() => undefined);
    realtimeChannel = null;
  }
  realtimeJoined = false;
}

/**
 * 配置注册/注销（宿主 auth-context 在登录态变化时调用）。
 */
export async function handleConfigChanged(
  config: SupabaseSyncConfig | null
): Promise<void> {
  if (config) {
    // 写点接线 + 推送器（幂等）
    installSyncWritePointWiring();
    syncPusher.start();
    // 回退开关（C.3）：置 1 可关停「登录拉取 + Realtime」，退回纯推送模式
    const cloudReadDisabled =
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('supabase_sync_disable_cloud_reconcile') === '1';
    if (cloudReadDisabled) {
      console.info('[SupabaseSync] 云端读路径已被开关关闭（仅保留本地推送）');
      return;
    }
    // Realtime 订阅（失败自动退化为轮询）
    await startRealtime(config);
    // 登录/启动全量 reconcile：SWR——UI 先渲染本地缓存，这里后台校准云端
    void reconcileFull().catch(() => undefined);
  } else {
    stopRealtime();
    syncPusher.stop();
    // 登出：清推送队列与同步基线——下次登录 lastSyncTime=null 走全量，
    // 不因残留基线漏拉其他设备在登出期间的变更
    await clearOutbox().catch(() => undefined);
    await kvStorageService.remove(LAST_SYNC_KEY).catch(() => undefined);
  }
}
