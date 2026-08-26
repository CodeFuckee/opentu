-- ============================================================
-- departments：部门表
--
-- 用途：维护部门清单，供注册表单下拉选择、staff_directory 等引用；
--       enabled（是否启用）用于控制该部门当前是否可选/可用。
--
-- 访问控制：
--   - 开启 RLS；
--   - anon / authenticated 仅可 SELECT：注册页在登录前也需要加载部门
--     下拉列表，且部门名称非敏感信息；
--   - 写入（INSERT/UPDATE/DELETE）仅 service_role，前端/普通用户不可改。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/departments.sql
-- ============================================================

-- 1. 建表（幂等）
create table if not exists public.departments (
  id          bigint generated always as identity primary key,
  name        text not null unique,              -- 部门名称（唯一）
  enabled     boolean not null default true,     -- 是否启用
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.departments is '部门表（名称 + 启用状态）';
comment on column public.departments.name is '部门名称';
comment on column public.departments.enabled is '是否启用';

-- 2. updated_at 自动更新触发器（复用 staff_directory.sql 中的 set_updated_at，
--    若该函数不存在则幂等创建，保证本文件可独立重跑）
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists departments_set_updated_at on public.departments;
create trigger departments_set_updated_at
  before update on public.departments
  for each row
  execute function public.set_updated_at();

-- 3. RLS：开启（写入默认被拒绝，仅 service_role 绕过）
alter table public.departments enable row level security;

-- 4. 读策略：anon / authenticated 均可读（登录前的注册页需要加载部门下拉）
drop policy if exists "departments_select_all" on public.departments;
create policy "departments_select_all"
  on public.departments
  for select
  to anon, authenticated
  using (true);

-- 5. 权限收紧：撤销 anon / authenticated 的写权限（自托管 Supabase 默认对
--    public 新表授权 ALL，必须显式收回写权限），仅显式授予 service_role
revoke insert, update, delete on public.departments from anon, authenticated;
grant select, insert, update, delete on public.departments to service_role;
