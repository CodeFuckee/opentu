-- ============================================================
-- video_model_access：视频模型使用白名单（上线即收紧）
--
-- 用法（自托管 Supabase，手工执行）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/video_model_access.sql
--
-- 设计要点：
--   * 表里一行 = 该用户可使用全部视频模型；无行 = 不可用（管理员例外，
--     user_profiles.role='admin' 恒放行）。
--   * 服务端硬拦截在 ai-proxy 边缘函数：POST 提交型视频请求（路径含 /videos）
--     转发前调 has_video_model_access 判定，不允许返回 403 video_access_denied。
--   * 管理方式：管理员在 Supabase Dashboard 的 Table Editor 里对
--     video_model_access 增/删行即可即时生效（每次提交实时判定，无需重启）。
--     user_id 填 auth.users 的 uuid（可在 Dashboard Authentication 页查看）。
--   * 前端自查走 RPC get_my_video_access（只能看自己），名单本身不对客户端
--     暴露（RLS 无任何 anon/authenticated 策略）。
--   * 注意：不能复用 is_admin() 做管理员判定——它无参且基于调用者 JWT 的
--     auth.uid()，经 service_role 调用时恒为 false；故在本文件内联 role 判断。
-- ============================================================

-- 1. 白名单表：可使用视频模型的用户一行
create table if not exists public.video_model_access (
  user_id    uuid        not null primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.video_model_access is '视频模型使用白名单（一行=该用户可用全部视频模型；删行=拒用；管理员恒放行）';
comment on column public.video_model_access.note is '备注（如部门/开通原因），可选';

-- updated_at 自动更新触发器（复用 set_updated_at，幂等创建）
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists video_model_access_set_updated_at on public.video_model_access;
create trigger video_model_access_set_updated_at
  before update on public.video_model_access
  for each row
  execute function public.set_updated_at();

-- 2. RLS：不授予任何客户端角色读写（管理员经 Dashboard/表属主身份编辑，
--    服务端经 service_role RPC 访问，不走本表直查；名单不外泄）
alter table public.video_model_access enable row level security;
revoke all on public.video_model_access from anon, authenticated;

-- ============================================================
-- 3. 服务端判定 RPC（ai-proxy 经 service_role 调用）
--    返回 jsonb { allowed: boolean }，与生图配额 RPC 的返回风格一致
-- ============================================================
create or replace function public.has_video_model_access(
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'allowed',
    exists (
      select 1 from video_model_access v where v.user_id = p_user_id
    ) or exists (
      select 1 from user_profiles up
      where up.user_id = p_user_id and up.role = 'admin'
    )
  );
$$;

revoke all on function public.has_video_model_access(uuid) from public, anon, authenticated;

-- ============================================================
-- 4. 前端自查 RPC（authenticated 经 REST 调用，只能看自己）
--    返回 jsonb { allowed: boolean }
-- ============================================================
create or replace function public.get_my_video_access()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.has_video_model_access(auth.uid());
$$;

revoke all on function public.get_my_video_access() from public, anon;
grant execute on function public.get_my_video_access() to authenticated;
