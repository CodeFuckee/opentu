/**
 * 任务参数 Supabase 归档运行时配置
 *
 * 宿主（apps/web）在登录态变化时注册/注销归档配置：
 * - 传入可用的 SupabaseClient（方案 B，官方 SDK 直连）
 * - 未注册（未登录或宿主未接入）时归档静默跳过
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TaskArchiveConfig {
  /** 可用的 SupabaseClient（已登录会话） */
  client: SupabaseClient;
  /** Storage bucket 名，默认 'huabu' */
  bucketName?: string;
}

let currentConfig: TaskArchiveConfig | null = null;

/** 注册/注销任务参数归档配置。传 null 表示停用归档。 */
export function configureTaskArchive(config: TaskArchiveConfig | null): void {
  currentConfig = config;
}

/** 读取当前归档配置（未注册返回 null） */
export function getTaskArchiveConfig(): TaskArchiveConfig | null {
  return currentConfig;
}
