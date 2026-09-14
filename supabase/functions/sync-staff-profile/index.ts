/**
 * Edge Function: sync-staff-profile (entry)
 *
 * 注册成功后，根据 staff_directory 表字段填写 user_profiles（详见 core.ts）。
 *
 * 请求：POST /functions/v1/sync-staff-profile
 *   body: { "userId": "uuid", "oaAccount": "zhangsan" }
 * 响应：
 *   200 { "synced": true, "staff": {...} }
 *   200 { "synced": false }            // staff_directory 无此 oa账号
 *   400 { "error": "..." }
 *   500 { "error": "..." }
 */
import {
  syncStaffProfile,
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

  // 鉴权：必须携带有效用户 JWT，且只能同步自己的资料
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
    console.error('[sync-staff-profile] auth verify failed:',
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
    const result = await syncStaffProfile(
      supabaseUrl,
      serviceRoleKey,
      userId,
      oaAccount
    );
    return jsonResponse(200, result);
  } catch (error) {
    // 上游细节只进日志，避免向客户端泄漏内部实现
    console.error('[sync-staff-profile] sync failed:',
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
