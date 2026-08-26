-- ============================================================
-- department_configs：部门配置表（key-value）
--
-- 用途：存放部门相关的配置项（如 key=模型配额、value=配置值），
--       键值对形式，key 唯一。
--
-- 访问控制（关键设计）：
--   "仅 Supabase 管理员可见" = 仅 service_role 可访问：
--   - 开启 RLS，且【不创建任何 anon / authenticated 策略】→ 默认拒绝；
--   - 显式 revoke anon / authenticated 的表级权限（自托管 Supabase 默认
--     对 public 新表授权 ALL，必须收回），杜绝普通用户可见/可改；
--   - 仅授予 service_role（绕过 RLS），Supabase 管理员通过
--     dashboard / SQL Editor / service_role key 访问。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/department_configs.sql
-- ============================================================

-- 1. 建表（幂等）：key 作主键，天然唯一
create table if not exists public.department_configs (
  key         text primary key,                  -- 配置键（部门相关，唯一）
  value       text not null,                     -- 配置值
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.department_configs is '部门配置表（key-value，仅 service_role 可访问）';
comment on column public.department_configs.key is '配置键（部门相关，唯一）';
comment on column public.department_configs.value is '配置值';

-- 2. updated_at 自动更新触发器（复用 set_updated_at，幂等创建）
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists department_configs_set_updated_at on public.department_configs;
create trigger department_configs_set_updated_at
  before update on public.department_configs
  for each row
  execute function public.set_updated_at();

-- 3. RLS：开启 + 不建任何 anon/authenticated 策略（默认 deny），仅 service_role 可访问
alter table public.department_configs enable row level security;

-- 4. 权限收紧：撤销 anon / authenticated 的全部权限，仅授予 service_role
revoke all on public.department_configs from anon, authenticated;
grant all on public.department_configs to service_role;
