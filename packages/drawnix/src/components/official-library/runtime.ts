/**
 * 官方素材库运行时配置（由宿主应用在登录态变化时注册，参照 template-gallery 模式）
 *
 * drawnix 包不直接依赖宿主的 supabase 客户端实例，通过本注册表解耦：
 * 宿主（apps/web）在建立会话时调用 configureOfficialLibrary({ client })，
 * 未注册（未登录/宿主未接入）时官方素材库入口显示空态。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface OfficialLibraryConfig {
  client: SupabaseClient;
  /** Supabase 基地址（client.supabaseUrl 为 protected，由宿主显式传入用于拼接公开桶直链） */
  supabaseUrl: string;
}

let currentConfig: OfficialLibraryConfig | null = null;

export function configureOfficialLibrary(
  config: OfficialLibraryConfig | null
): void {
  currentConfig = config;
}

export function getOfficialLibraryConfig(): OfficialLibraryConfig | null {
  return currentConfig;
}
