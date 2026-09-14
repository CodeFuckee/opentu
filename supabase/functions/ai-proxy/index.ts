/**
 * Edge Function: ai-proxy (entry)
 *
 * 生图额度管控代理。逻辑见 core.ts，配额函数见 supabase/migrations/generation_usage.sql。
 *
 * 请求：/functions/v1/ai-proxy/<任意上游路径>?<query>
 *   - Authorization: Bearer <Supabase JWT>（必需）
 *   - 方法/请求体原样转发到 configs.NEWAPI_URL 指向的上游
 *   - GET /functions/v1/ai-proxy/quota → { "quota": { limit, used, remaining, period } }
 * 响应：上游响应透传（已过滤受限头）；管控错误返回 401/403/503 JSON。
 *
 * 自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL（容器内已配置）。
 */
import { CORS_HEADERS, handleAiProxyRequest } from './core.ts';

const PROXY_PREFIX = '/ai-proxy';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonError(500, 'SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL not configured');
  }

  // 解析路径前缀：/functions/v1/ai-proxy[/...] 或裸 [/...]（容器内直连可能无 /functions/v1）
  let urlPath = '';
  try {
    urlPath = new URL(request.url).pathname;
  } catch {
    return jsonError(400, 'invalid request url');
  }

  let suffix = '';
  if (urlPath === '/functions/v1' + PROXY_PREFIX) {
    suffix = '/';
  } else if (urlPath.startsWith('/functions/v1' + PROXY_PREFIX + '/')) {
    suffix = urlPath.slice(('/functions/v1' + PROXY_PREFIX).length);
  } else if (
    urlPath === PROXY_PREFIX ||
    urlPath.startsWith(PROXY_PREFIX + '/')
  ) {
    suffix = urlPath.slice(PROXY_PREFIX.length);
  } else {
    return jsonError(404, `unknown proxy path: ${urlPath}`);
  }

  try {
    return await handleAiProxyRequest({
      env: { SUPABASE_URL: supabaseUrl, SERVICE_ROLE_KEY: serviceRoleKey },
      request,
      pathSuffix: suffix,
    });
  } catch (error) {
    // 内部细节只进日志，避免向客户端泄漏实现
    console.error('[ai-proxy] unhandled error:',
      error instanceof Error ? error.message : error);
    return jsonError(500, 'internal error');
  }
});

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
