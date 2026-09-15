/**
 * Edge Function: task-monitor (entry)
 *
 * 监控 task_submissions 表中的生图任务：窗口内是否仍有 60s WorkerRequestCancelled
 * 被杀记录、是否存在 >60s 成功完成的任务。Core logic lives in core.ts.
 *
 * Self-hosted instance specifics:
 * - Env var name: SUPABASE_SERVICE_ROLE_KEY (configured on the container)
 * - SUPABASE_URL is the in-container gateway address (http://api-gw:8000)
 *
 * 用法：
 *   GET  /functions/v1/task-monitor?hours=24
 *   POST /functions/v1/task-monitor   {"hours": 24}
 *   Authorization: Bearer <有效的 Supabase 用户 JWT>
 */
import { handleTaskMonitor } from './core.ts';

Deno.serve(async (request: Request) => {
  return handleTaskMonitor(request, {
    SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
  });
});
