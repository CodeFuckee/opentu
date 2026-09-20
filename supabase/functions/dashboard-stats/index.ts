/**
 * Edge Function: dashboard-stats (entry)
 *
 * 托管在 Supabase 后端的数据看板：页面与聚合数据接口都由本函数提供。
 * 逻辑见 core.ts。
 *
 * 请求（自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL /
 * SUPABASE_ANON_KEY，容器内已配置）：
 *   GET  /functions/v1/dashboard-stats/            → 200 自包含 HTML 看板页面
 *   GET  /functions/v1/dashboard-stats/overview?days=N → 200 JSON 四类聚合统计
 *   POST /functions/v1/dashboard-stats/push-report → 推送周报到生产群（DINGTALK_WEBHOOK）
 *   POST /functions/v1/dashboard-stats/push-test   → 完整周报链路推开发群（DEV_DINGTALK_WEBHOOK，强制 DEV_DINGTALK_SECRET 加签）
 *   OPTIONS                                        → 204 CORS
 *   其他方法/路径                                   → 405/404
 *
 * 鉴权（2026-09-16 起强制）：页面是匿名可取的登录壳（不含数据）；/overview、
 * /push-report 与 /push-test 要求「有效用户 JWT + is_admin()=true」（未登录/无效 401、
 * 非管理员 403）。页面自带 oa账号+密码登录，登录后以 access_token 调用。
 * SUPABASE_ANON_KEY 缺失时拒绝启动（不再硬编码兜底）。
 */
import {
  aggregateOverview,
  buildDashboardHtml,
  pushReport,
  verifyDashboardAdmin,
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
  // 兼容两种容器注入名：SUPABASE_ANON_KEY（本仓库约定）与 ANON_KEY（自托管 edge-runtime 常见名）
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('ANON_KEY') || '';
  if (!serviceRoleKey || !supabaseUrl || !anonKey) {
    return jsonError(500, 'dashboard-stats is not configured: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL / (SUPABASE_ANON_KEY|ANON_KEY) are required');
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
        // 登录壳页面不含任何数据（骨架 + 登录框），匿名可取；
        // 数据接口才需要管理员 JWT——若连页面也 401，登录框将永远无从展示
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
        // 门禁：仅管理员（未登录 401、非管理员 403）
        const gate = await verifyDashboardAdmin(env, request);
        if (!gate.ok) {
          return jsonError(gate.status, gate.error);
        }
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
      // 门禁：仅管理员
      const gate = await verifyDashboardAdmin(env, request);
      if (!gate.ok) {
        return jsonError(gate.status, gate.error);
      }
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

    if (route.kind === 'push-test' && request.method === 'POST') {
      // 门禁：仅管理员。推送测试：完整周报链路推 DEV_DINGTALK_WEBHOOK（开发群），
      // 强制 DEV_DINGTALK_SECRET 加签；结果由开发群实际收到情况验证，页面不回显。
      const gate = await verifyDashboardAdmin(env, request);
      if (!gate.ok) {
        return jsonError(gate.status, gate.error);
      }
      const body = (await request.json().catch(() => ({}))) as {
        imageBase64?: unknown;
        text?: unknown;
      };
      const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64 : '';
      const text = typeof body.text === 'string' ? body.text : '';
      const result = await pushReport(env, {}, imageBase64, text, { dev: true });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return jsonError(405, 'Method not allowed');
  } catch (error) {
    // 内部细节（表名/RPC/PostgREST 报文）只进日志，不回传客户端
    console.error('[dashboard-stats] unhandled error:',
      error instanceof Error ? error.message : error);
    return jsonError(500, 'internal error');
  }
});

/** 解析路径：页面（BASE 本身 / index.html / 尾部斜杠）或数据接口（overview/push-report/push-test） */
function parseRoute(
  urlPath: string
): { kind: 'page' } | { kind: 'overview' } | { kind: 'push' } | { kind: 'push-test' } | { kind: 'unknown' } {
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
  if (clean === '/push-test') {
    return { kind: 'push-test' };
  }
  return { kind: 'unknown' };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
