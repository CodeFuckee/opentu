/**
 * Edge Function: newapi-key (entry)
 *
 * 为用户获取/创建 new-api apikey。流程与 API 细节见 core.ts。
 *
 * 请求：POST /functions/v1/newapi-key
 *   body: { "userId": "uuid", "oaAccount": "zhangsan" }
 * 响应：
 *   200 { "apikey": "sk-..." }
 *   400 { "error": "..." }   // 参数错误
 *   500 { "error": "..." }   // 上游失败
 *
 * 自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL（容器内已配置）。
 */
import { getOrCreateApiKey } from './core.ts';

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonResponse(500, {
      error: 'SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL not configured',
    });
  }

  let userId = '';
  let oaAccount = '';
  try {
    const payload = (await request.json()) as {
      userId?: unknown;
      oaAccount?: unknown;
    };
    userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
    oaAccount =
      typeof payload.oaAccount === 'string' ? payload.oaAccount.trim() : '';
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!userId || !oaAccount) {
    return jsonResponse(400, {
      error: 'userId and oaAccount are required',
    });
  }

  try {
    const result = await getOrCreateApiKey(
      supabaseUrl,
      serviceRoleKey,
      userId,
      oaAccount
    );
    return jsonResponse(200, { apikey: result.apikey });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown upstream error';
    return jsonResponse(500, { error: message });
  }
});

function jsonResponse(
  status: number,
  body: Record<string, unknown>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
