/**
 * supabase-sync 运行时配置
 *
 * 宿主（apps/web）在登录态变化时注册/注销同步配置：
 * - 传入可用的 SupabaseClient（与 task-supabase-archive 同模式）
 * - 未注册（未登录或宿主未接入）时同步静默跳过
 */
import type { SupabaseSyncConfig } from './types';

let currentConfig: SupabaseSyncConfig | null = null;

/** 注册/注销云同步配置。传 null 表示停用同步。 */
export function configureSupabaseSync(config: SupabaseSyncConfig | null): void {
  currentConfig = config;
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