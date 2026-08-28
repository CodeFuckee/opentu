-- ============================================================
-- task_submissions：响应归档列（ai-proxy 服务端写入）
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres \
--     < supabase/migrations/task_submissions_add_upstream_response.sql
--
-- upstream_response  jsonb  — new-api 返回的原始响应 JSON（base64 已替换为
--                             huabu bucket 存储路径；上传失败则保留原 base64）。
--                             由 ai-proxy 边缘函数在任务终态时写入，
--                             仅覆盖这两个新增列，不影响前端回写的
--                             params/status/result/error。
-- response_file_paths jsonb — 本次响应归档上传到 huabu bucket 的 output 文件
--                             路径列表（{username}/{YYYY-MM-DD}/output-{sha256}.{ext}）。
-- ============================================================

alter table public.task_submissions
  add column if not exists upstream_response jsonb;

alter table public.task_submissions
  add column if not exists response_file_paths jsonb not null default '[]'::jsonb;

comment on column public.task_submissions.upstream_response is
  'new-api 原始响应 JSON（ai-proxy 归档，base64 已替换为 huabu 存储路径）';
comment on column public.task_submissions.response_file_paths is
  '响应归档上传到 huabu bucket 的 output 文件路径列表';