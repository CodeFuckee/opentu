/**
 * supabase-sync 运行时配置
 *
 * 宿主（apps/web）在登录态变化时注册/注销同步配置：
 * - 传入可用的 SupabaseClient（与 task-supabase-archive 同模式）
 * - 未注册（未登录或宿主未接入）时同步静默跳过
 */
import type { SupabaseSyncConfig } from './types';

let currentConfig: SupabaseSyncConfig | null = null;

/** 云端读路径是否被本地隔离开关关闭（e2e 本地隔离/用户手动回退共用） */
export function isCloudPullDisabled(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('supabase_sync_disable_cloud_reconcile') === '1'
    );
  } catch {
    return false;
  }
}

/** Realtime 订阅通道的最小结构面（supabase-js RealtimeChannel 的子集） */
export interface RealtimeChannelLike {
  channelLike: {
    on: (
      event: string,
      opts: Record<string, unknown>,
      cb: () => void
    ) => unknown;
    subscribe: (cb: (status: string) => void) => unknown;
  };
  unsubscribe: () => Promise<unknown>;
}

/** 注册/注销云同步配置。传 null 表示停用同步。 */
export function configureSupabaseSync(config: SupabaseSyncConfig | null): void {
  currentConfig = config;
  // 生命周期接管（登录/登出）：接线、推送器、Realtime、登录 reconcile、登出清理。
  // 动态 import 避免与 infra 的静态循环依赖（infra 反向读取本模块的 config）
  void import('./infra')
    .then((m) => m.handleConfigChanged(config))
    .catch((error) => {
      console.warn('[SupabaseSync] infra 处理配置变更失败:', error);
    });
}

/** 读取当前同步配置（未注册返回 null） */
export function getSupabaseSyncConfig(): SupabaseSyncConfig | null {
  return currentConfig;
}

/** 读取当前登录用户（无会话返回 null） */
export async function getSupabaseSyncUser(
  config: SupabaseSyncConfig
): Promise<{ id: string; email?: string } | null> {
  const client = config.client as {
    auth: { getSession: () => Promise<{ data: { session: { user: { id: string; email?: string } | null } | null } }> };
  };
  const { data } = await client.auth.getSession();
  const user = data.session?.user;
  return user ? { id: user.id, email: user.email } : null;
}