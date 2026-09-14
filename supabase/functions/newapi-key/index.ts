/**
 * Edge Function: newapi-key (entry)
 *
 * 为用户获取/创建 new-api apikey。流程与 API 细节见 core.ts。
 *
 * 请求：POST /functions/v1/newapi-key（Authorization: Bearer <用户 JWT>）
 *   body: { "userId": "uuid", "oaAccount": "zhangsan" }
 * 响应：
 *   200 { "apikey": "sk-..." }
 *   400 { "error": "..." }   // 参数错误
 *   401 { "error": "..." }   // 未认证
 *   403 { "error": "..." }   // userId 与认证身份不一致
 *   500 { "error": "..." }   // 上游失败
 *
 * 自托管实例：环境变量 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL（容器内已配置）。
 */
import {
  getOrCreateApiKey,
  verifyCallerUserId,
  extractBearerToken,
  isValidUuid,
  CallerAuthError,
} from './core.ts';

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

  // 鉴权：必须携带有效用户 JWT，且只能操作自己的 apikey
  const accessToken = extractBearerToken(request);
  if (!accessToken) {
    return jsonResponse(401, { error: 'missing bearer token' });
  }
  let callerId: string;
  try {
    callerId = await verifyCallerUserId(supabaseUrl, accessToken, serviceRoleKey);
  } catch (error) {
    if (error instanceof CallerAuthError) {
      return jsonResponse(401, { error: 'invalid or expired token' });
    }
    console.error('[newapi-key] auth verify failed:',
      error instanceof Error ? error.message : error);
    return jsonResponse(502, { error: 'auth verify failed' });
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
  if (!isValidUuid(userId)) {
    return jsonResponse(400, { error: 'userId must be a valid uuid' });
  }
  if (userId !== callerId) {
    return jsonResponse(403, { error: 'userId does not match caller' });
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
    // 上游细节只进日志，避免向客户端泄漏内部实现
    console.error('[newapi-key] getOrCreateApiKey failed:',
      error instanceof Error ? error.message : error);
    return jsonResponse(500, { error: 'internal error' });
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
