/**
 * 模板中心运行时配置（由宿主应用在登录态变化时注册，参照 task-archive 模式）
 *
 * drawnix 包不直接依赖宿主的 supabase 客户端实例，通过本注册表解耦：
 * 宿主（apps/web）在建立会话时调用 configureTemplateGallery({ client })，
 * 未注册（未登录/宿主未接入）时模板入口不渲染。
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface TemplateGalleryConfig {
  client: SupabaseClient;
  /** Supabase 基地址(CLIP 模型桶等公开直链拼接用;缺省回退官方库注册值) */
  supabaseUrl?: string;
}

let currentConfig: TemplateGalleryConfig | null = null;

export function configureTemplateGallery(
  config: TemplateGalleryConfig | null
): void {
  currentConfig = config;
}

export function getTemplateGalleryConfig(): TemplateGalleryConfig | null {
  return currentConfig;
}
