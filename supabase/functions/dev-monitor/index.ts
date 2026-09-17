/**
 * Edge Function: dev-monitor (entry)
 *
 * 开发监控看板：服务健康探测 + 任务管线真实口径聚合 + 失败样本。
 * 逻辑见 core.ts（纯逻辑，注入 fetch 可单测）。
 *
 * 请求（自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL /
 * SUPABASE_ANON_KEY，容器内已配置）：
 *   GET  /functions/v1/dev-monitor/           → 200 自包含 HTML 页面（匿名登录壳，不含数据）
 *   GET  /functions/v1/dev-monitor/status?days=N → 200 JSON 聚合（管理员门禁）
 *   OPTIONS                                   → 204 CORS
 *   其他方法/路径                              → 405/404
 *
 * 鉴权：与 dashboard-stats 相同——页面匿名可取；/status 要求
 * 「有效用户 JWT + is_admin()=true」（未登录/无效 401、非管理员 403 fail-closed）。
 */
import { aggregateStatus, buildDevMonitorHtml, verifyDevAdmin, type DevMonitorEnv } from './core.ts';

const BASE = '/dev-monitor';

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
    return jsonError(500, 'dev-monitor is not configured: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL / (SUPABASE_ANON_KEY|ANON_KEY) are required');
  }
  const env: DevMonitorEnv = {
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
        // 登录壳页面不含任何数据（骨架 + 登录框），匿名可取
        const html = buildDevMonitorHtml(anonKey);
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            ...CORS_HEADERS,
          },
        });
      }
      if (route.kind === 'status') {
        // 门禁：仅管理员（未登录 401、非管理员 403 fail-closed）
        const gate = await verifyDevAdmin(env, request);
        if (!gate.ok) {
          return jsonError(gate.status, gate.error);
        }
        const params = new URL(request.url).searchParams;
        const daysParam = params.get('days');
        const days = typeof daysParam === 'string' ? Number(daysParam) : 7;
        const status = await aggregateStatus(env, Number.isFinite(days) ? days : 7);
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...CORS_HEADERS,
          },
        });
      }
      return jsonError(404, `unknown dev-monitor path: ${urlPath}`);
    }

    return jsonError(405, 'Method not allowed');
  } catch (error) {
    // 内部细节（表名/RPC/PostgREST 报文）只进日志，不回传客户端
    console.error('[dev-monitor] unhandled error:',
      error instanceof Error ? error.message : error);
    return jsonError(500, 'internal error');
  }
});

/** 解析路径：页面（BASE 本身 / index.html / 尾部斜杠）或数据接口（status） */
function parseRoute(
  urlPath: string
): { kind: 'page' } | { kind: 'status' } | { kind: 'unknown' } {
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
  if (clean === '/status') {
    return { kind: 'status' };
  }
  return { kind: 'unknown' };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
