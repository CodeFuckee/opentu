/**
 * Edge Function: feedbackland-sso (entry)
 *
 * opentu → Feedbackland 免登跳转的一次性凭据发放：
 *   POST /functions/v1/feedbackland-sso
 *        Authorization: Bearer <opentu 用户 JWT>
 *        → 200 { token_hash }（一次性 magic link token）
 *
 * Feedbackland 回调页（/[orgSubdomain]/auth/sso）持 token_hash 调
 * supabase.auth.verifyOtp 建立会话，实现跨应用免登。
 * 逻辑见 core.ts；环境变量 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * 由自托管 Supabase 容器注入。
 */
import { handleFeedbackSsoRequest } from './core.ts';

Deno.serve((request: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: 'function env not configured' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return handleFeedbackSsoRequest(request, {
    supabaseUrl,
    serviceRoleKey,
  });
});
