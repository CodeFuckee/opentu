/**
 * 模板中心 E2E 种子数据（仅操作 source='e2e' 的专用行，不污染真实爬取数据）
 *
 * - seedE2eTemplates()：幂等 upsert 两条种子模板（【E2E】前缀标题）
 * - cleanupE2eTemplates()：删除种子模板及其使用记录
 *
 * 需要 SUPABASE.serviceRoleKey（apps/web-e2e/.env.e2e.local 或环境变量注入）。
 */
import { SUPABASE } from '../config/e2e.config';

export const E2E_TEMPLATE_SOURCE = 'e2e';
export const E2E_TEMPLATE_TITLE_PREFIX = '【E2E】';

export const TEMPLATE_A = {
  source: E2E_TEMPLATE_SOURCE,
  source_id: 'e2e-template-a',
  title: `${E2E_TEMPLATE_TITLE_PREFIX}热度样例模板A`,
  category: '效果渲染',
  catalogs: [['效果渲染', '景观渲染']],
  prompt: 'E2E 种子提示词 A：渲染一幅新中式庭院黄昏实景，暖光治愈氛围。',
  base_images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='],
  status: 'active',
  usage_count: 999999,
  likes: 12,
};

export const TEMPLATE_B = {
  source: E2E_TEMPLATE_SOURCE,
  source_id: 'e2e-template-b',
  title: `${E2E_TEMPLATE_TITLE_PREFIX}最新样例模板B`,
  category: '分析图',
  catalogs: [['分析图', '场地分析']],
  prompt: 'E2E 种子提示词 B：绘制一幅滨水场地分析图，包含交通与视线分析。',
  base_images: [],
  status: 'active',
  usage_count: 1,
  likes: 3,
};

interface SeedContext {
  baseUrl: string;
  serviceRoleKey: string;
}

function requireServiceKey(): SeedContext {
  const baseUrl = SUPABASE.url.replace(/\/$/, '');
  if (!SUPABASE.serviceRoleKey) {
    throw new Error(
      '缺少 E2E_SUPABASE_SERVICE_ROLE_KEY（apps/web-e2e/.env.e2e.local 或环境变量），无法播种模板中心种子数据'
    );
  }
  return { baseUrl, serviceRoleKey: SUPABASE.serviceRoleKey };
}

function serviceHeaders(ctx: SeedContext): Record<string, string> {
  return {
    apikey: ctx.serviceRoleKey,
    Authorization: `Bearer ${ctx.serviceRoleKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  };
}

/** 幂等播种两条种子模板（crawled_at 取当前时间，保证「最新」排序首位） */
export async function seedE2eTemplates(): Promise<void> {
  const ctx = requireServiceKey();
  const nowIso = new Date().toISOString();
  const rows = [
    { ...TEMPLATE_A, crawled_at: new Date(Date.now() - 60_000).toISOString() },
    { ...TEMPLATE_B, crawled_at: nowIso },
  ];
  const response = await fetch(
    `${ctx.baseUrl}/rest/v1/ai_templates?on_conflict=source,source_id`,
    {
      method: 'POST',
      headers: serviceHeaders(ctx),
      body: JSON.stringify(rows),
    }
  );
  if (!response.ok) {
    throw new Error(`播种模板失败 ${response.status}: ${await response.text()}`);
  }
}

/** 清理种子模板及其使用记录（幂等） */
export async function cleanupE2eTemplates(): Promise<void> {
  const ctx = requireServiceKey();
  const headers = serviceHeaders(ctx);
  // 先删使用记录（外键引用），再删模板行
  const logDel = await fetch(
    `${ctx.baseUrl}/rest/v1/template_usage_log?template_id=in.(select id from ai_templates where source=eq.${E2E_TEMPLATE_SOURCE})`,
    { method: 'DELETE', headers }
  );
  if (!logDel.ok && logDel.status !== 404) {
    // in.(select ...) 需要 allowlist；失败时退化为两步删除
    const list = await fetch(
      `${ctx.baseUrl}/rest/v1/ai_templates?select=id&source=eq.${E2E_TEMPLATE_SOURCE}`,
      { method: 'GET', headers }
    );
    if (list.ok) {
      const rows = (await list.json()) as Array<{ id: string }>;
      const ids = rows.map((r) => r.id);
      if (ids.length) {
        await fetch(
          `${ctx.baseUrl}/rest/v1/template_usage_log?template_id=in.(${ids.join(',')})`,
          { method: 'DELETE', headers }
        );
      }
    }
  }
  const del = await fetch(
    `${ctx.baseUrl}/rest/v1/ai_templates?source=eq.${E2E_TEMPLATE_SOURCE}`,
    { method: 'DELETE', headers }
  );
  if (!del.ok) {
    throw new Error(`清理种子模板失败 ${del.status}: ${await del.text()}`);
  }
}

/** 读取种子模板当前使用计数（断言 +1 用） */
export async function getSeedUsageCount(sourceId: string): Promise<number> {
  const ctx = requireServiceKey();
  const response = await fetch(
    `${ctx.baseUrl}/rest/v1/ai_templates?select=usage_count&source=eq.${E2E_TEMPLATE_SOURCE}&source_id=eq.${sourceId}`,
    { method: 'GET', headers: serviceHeaders(ctx) }
  );
  if (!response.ok) return 0;
  const rows = (await response.json()) as Array<{ usage_count?: number }>;
  return rows[0]?.usage_count ?? 0;
}
