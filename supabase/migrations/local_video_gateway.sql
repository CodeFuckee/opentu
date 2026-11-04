-- ============================================================
-- local_video_gateway：本地视频网关（MiniMax H3）任务路由
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/local_video_gateway.sql
--
-- 背景：
--   ai-proxy 原本把全部流量原样转发到 configs.NEWAPI_URL（第三方网关）。
--   接入服务器本地部署的 MiniMax H3 视频网关后按模型名分流：
--   - 提交（POST …/videos）：解析表单/JSON 的 model，命中 LOCAL_VIDEO_MODEL_PATTERN
--     的请求改转 LOCAL_VIDEO_GATEWAY_URL；
--   - 轮询（GET …/videos/{id}[/content]）：按本表记录的提交模型决定转发目标
--     （无记录 → 默认 NEWAPI_URL，现有任务不受影响）。
--
--   本表只记「命中本地网关分流」的任务（量小），不参与计费/退额语义
--   （本地视频不计费，generation_task_bills 语义保持不变）。
--
-- 网关地址与分流模式两条 configs（幂等写入，不覆盖已有值；调整直接 UPDATE）：
--   LOCAL_VIDEO_GATEWAY_URL   本地视频网关基地址（缺省不配置 = 功能关闭）
--   LOCAL_VIDEO_MODEL_PATTERN 命中该正则（不区分大小写）的模型名走本地网关，
--                             如 '^MiniMax-H3$'（锚定，避免误吞 MiniMax-M2 等
--                             第三方中转模型）
--
-- ⚠️ 部署顺序：LOCAL_VIDEO_MODEL_PATTERN 生效前，须确保前端（含 minimax-h3
--    adapter）已上线，否则老前端提交的未知模型不会命中本模式，无副作用。
-- ============================================================

create table if not exists public.local_video_task_routes (
  upstream_id text        not null primary key,   -- 上游任务 id（本地网关返回的 uuid）
  model       text        not null,               -- 提交时的模型名（表单/JSON model 字段）
  created_at  timestamptz not null default now()
);

comment on table public.local_video_task_routes is '本地视频网关任务路由（提交时记 model，轮询时据此分流转发目标）';

alter table public.local_video_task_routes enable row level security;
revoke all on public.local_video_task_routes from anon, authenticated;

-- 提交成功后记录路由（幂等）
create or replace function public.record_local_video_route(
  p_upstream_id text,
  p_model       text
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into local_video_task_routes (upstream_id, model)
  values (p_upstream_id, p_model)
  on conflict (upstream_id) do nothing;
$$;

-- 轮询分流查询：返回该任务提交时的模型名（无记录返回 null）
create or replace function public.get_local_video_route_model(p_upstream_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select model from local_video_task_routes where upstream_id = p_upstream_id limit 1;
$$;

-- 仅 service_role 可执行（经 ai-proxy 访问）
revoke all on function public.record_local_video_route(text, text) from anon, authenticated;
revoke all on function public.get_local_video_route_model(text)     from anon, authenticated;

-- 网关地址与分流模式（幂等写入；不覆盖已有配置，改值直接 UPDATE）
insert into public.configs (key, value)
values
  ('LOCAL_VIDEO_GATEWAY_URL', 'http://10.0.0.220:8788'),
  ('LOCAL_VIDEO_MODEL_PATTERN', '^MiniMax-H3$')
on conflict (key) do nothing;
