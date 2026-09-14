/**
 * Edge Function: dashboard-stats (entry)
 *
 * 托管在 Supabase 后端的数据看板：页面与聚合数据接口都由本函数提供。
 * 逻辑见 core.ts。
 *
 * 请求（自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL，容器内已配置）：
 *   GET  /functions/v1/dashboard-stats/            → 200 自包含 HTML 看板页面
 *   GET  /functions/v1/dashboard-stats/overview?days=N → 200 JSON 四类聚合统计
 *   OPTIONS                                        → 204 CORS
 *   其他方法/路径                                   → 405/404
 *
 * 鉴权：暂不做（本函数不校验调用者；页面 JS 带 anon key 供 Kong 放行）。
 */
import {
  aggregateOverview,
  buildDashboardHtml,
  pushReport,
  DEFAULT_ANON_KEY,
  type DashboardEnv,
} from './core.ts';

const BASE = '/dashboard-stats';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || DEFAULT_ANON_KEY;
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonError(500, 'SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL not configured');
  }
  const env: DashboardEnv = {
    SUPABASE_URL: supabaseUrl,
    SERVICE_ROLE_KEY: serviceRoleKey,
    ANON_KEY: anonKey,
  };

  let urlPath = '';
  try {
    urlPath = new URL(request.url).pathname;
  } catch {
    return jsonError(400, 'invalid request url');
  }

  const route = parseRoute(urlPath);

  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (route.kind === 'page') {
        const html = buildDashboardHtml(anonKey);
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...CORS_HEADERS,
          },
        });
      }
      if (route.kind === 'overview') {
        const params = new URL(request.url).searchParams;
        const daysParam = params.get('days');
        const days = typeof daysParam === 'string' ? Number(daysParam) : 30;
        const startParam = params.get('start');
        const endParam = params.get('end');
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        const range =
          typeof startParam === 'string' &&
          typeof endParam === 'string' &&
          dateRe.test(startParam) &&
          dateRe.test(endParam)
            ? { start: startParam, end: endParam }
            : undefined;
        const overview = await aggregateOverview(
          env,
          Number.isFinite(days) ? days : 30,
          {},
          range
        );
        return new Response(JSON.stringify(overview), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...CORS_HEADERS,
          },
        });
      }
      return jsonError(404, `unknown dashboard-stats path: ${urlPath}`);
    }

    if (route.kind === 'push' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        imageBase64?: unknown;
        text?: unknown;
      };
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const result = await pushReport(env, {}, imageBase64, text);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return jsonError(405, 'Method not allowed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return jsonError(500, message.slice(0, 200));
  }
});

/** 解析路径：页面（BASE 本身 / index.html / 尾部斜杠）或数据接口（overview） */
function parseRoute(
  urlPath: string
): { kind: 'page' } | { kind: 'overview' } | { kind: 'push' } | { kind: 'unknown' } {
  const suffix = urlPath.startsWith('/functions/v1' + BASE)
    ? urlPath.slice(('/functions/v1' + BASE).length)
    : urlPath.startsWith(BASE)
      ? urlPath.slice(BASE.length)
      : null;

  if (suffix === null) {
    return { kind: 'unknown' };
  }
  const clean = suffix.replace(/\/+$/, '');
  if (clean === '' || clean === '/index.html') {
    return { kind: 'page' };
  }
  if (clean === '/overview') {
    return { kind: 'overview' };
  }
  if (clean === '/push-report') {
    return { kind: 'push' };
  }
  return { kind: 'unknown' };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
