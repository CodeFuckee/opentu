/**
 * Edge Function: ui-stats (entry)
 *
 * 按钮使用统计的入库通道（openspec add-button-usage-stats）：前端采集器批量
 * 上报按钮点击事件，本函数校验后以 service_role 写入 ui_click_events。
 * 聚合查询不在本函数——dashboard-stats 看板以 service_role 直查渲染
 * 「按钮使用统计」面板（非管理员不可见）。
 *
 * 请求（自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL，容器内已配置）：
 *   POST /functions/v1/ui-stats/ingest → 200 {inserted:N}；未登录/无效 JWT 401、
 *                                        字段缺失或超批量上限 400、上游失败 502
 *   OPTIONS                            → 204 CORS
 *   其他方法/路径                       → 405/404
 */
import { ingestEvents, type UiStatsEnv } from './core.ts';

const BASE = '/ui-stats';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
    });
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonError(
      500,
      'ui-stats is not configured: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL are required'
    );
  }
  const env: UiStatsEnv = {
    SUPABASE_URL: supabaseUrl,
    SERVICE_ROLE_KEY: serviceRoleKey,
  };

  let urlPath = '';
  try {
    urlPath = new URL(request.url).pathname;
  } catch {
    return jsonError(400, 'invalid request url');
  }

  const suffix = urlPath.startsWith('/functions/v1' + BASE)
    ? urlPath.slice(('/functions/v1' + BASE).length)
    : urlPath.startsWith(BASE)
      ? urlPath.slice(BASE.length)
      : null;
  const clean = suffix === null ? null : suffix.replace(/\/+$/, '');

  if (request.method === 'POST' && clean === '/ingest') {
    try {
      const result = await ingestEvents(env, request);
      if (!result.ok) {
        return jsonError(result.status, result.error);
      }
      return new Response(JSON.stringify({ inserted: result.inserted }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    } catch (error) {
      // 内部细节只进日志，不回传客户端
      console.error('[ui-stats] unhandled error:',
        error instanceof Error ? error.message : error);
      return jsonError(500, 'internal error');
    }
  }

  if (clean === '/ingest') {
    return jsonError(405, 'Method not allowed');
  }
  return jsonError(404, `unknown ui-stats path: ${urlPath}`);
});

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
