/**
 * Edge Function: check-register (entry)
 *
 * 注册资格校验（详见 core.ts）。
 *
 * 请求：POST /functions/v1/check-register
 *   body: { "oaAccount": "zhangsan" }
 * 响应：
 *   200 { "eligible": true }
 *   200 { "eligible": false, "reason": "not-staff" | "department-disabled" }
 *   400 { "error": "..." }
 *   500 { "error": "..." }
 */
import { checkRegisterEligibility } from './core.ts';

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

  let oaAccount = '';
  try {
    const payload = (await request.json()) as { oaAccount?: unknown };
    oaAccount =
      typeof payload.oaAccount === 'string' ? payload.oaAccount.trim() : '';
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!oaAccount) {
    return jsonResponse(400, { error: 'oaAccount is required' });
  }

  try {
    const result = await checkRegisterEligibility(
      supabaseUrl,
      serviceRoleKey,
      oaAccount
    );
    return jsonResponse(200, result);
  } catch (error) {
    // 上游细节只进日志，避免向客户端泄漏内部实现
    console.error('[check-register] check failed:',
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
