/**
 * Edge Function: reconcile-worker (entry)
 *
 * 平台↔new-api↔tuzi 对账救回的定时轮（默认每 5 分钟由服务器 cron curl 触发）。
 *
 * 请求：POST /functions/v1/reconcile-worker
 *   - Authorization: Bearer <SERVICE_ROLE_KEY>（必需，仅触发器/管理员可调）
 * 行为见 core.ts：任务锁 + 完成时间链式间隔（5 分钟不含运行时间）+ 熔断 +
 * 有活才干活；动作明细写入响应并在有实际动作时推送钉钉。
 */
import { runTick as handleReconcileTick } from './core.ts';

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' });
  }

  const serviceRoleKey = Deno.env.get('SERVICE_ROLE_KEY') ||
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  if (!serviceRoleKey || !supabaseUrl) {
    return jsonResponse(500, {
      error: 'SERVICE_ROLE_KEY / SUPABASE_URL not configured',
    });
  }

  const auth = request.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${serviceRoleKey}`) {
    return jsonResponse(403, { error: 'forbidden: trigger only' });
  }

  try {
    const result = await handleReconcileTick({
      supabaseUrl,
      serviceRoleKey,
    });
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(500, {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
