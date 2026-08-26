-- ============================================================
-- staff_directory：注册白名单 / 人员花名册表
--
-- 用途：用户注册时按 oa_account 匹配本表，只有表内人员才能注册；
--       注册成功后，将 department / region / position / name 写入
--       user_profiles（以及 auth.users 的 raw_user_meta_data）。
--
-- 访问控制（关键设计）：
--   - 开启 RLS，且【不创建任何 anon / authenticated 策略】→ 默认拒绝；
--   - 显式 revoke anon / authenticated 的表级权限，杜绝未来误开放；
--   - 仅 service_role 可读写（绕过 RLS），供 Edge Function 用 service_role key
--     做白名单校验，避免前端直接查表导致花名册（姓名/OA账号）被枚举泄露。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/staff_directory.sql
-- ============================================================

-- 1. 建表（幂等）
create table if not exists public.staff_directory (
  id          bigint generated always as identity primary key,
  department  text not null,                     -- 部门
  region      text not null,                     -- 区域
  position    text not null,                     -- 岗位
  name        text not null,                     -- 姓名
  oa_account  text not null unique,              -- OA账号（注册匹配键，唯一）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.staff_directory is '注册白名单 / 人员花名册（仅 service_role 可访问，按 oa_account 匹配注册资格）';
comment on column public.staff_directory.department is '部门';
comment on column public.staff_directory.region is '区域';
comment on column public.staff_directory.position is '岗位';
comment on column public.staff_directory.name is '姓名';
comment on column public.staff_directory.oa_account is 'OA账号（注册匹配键，唯一）';

-- 2. updated_at 自动更新触发器（复用 user_profiles.sql 中的 set_updated_at；
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

drop trigger if exists staff_directory_set_updated_at on public.staff_directory;
create trigger staff_directory_set_updated_at
  before update on public.staff_directory
  for each row
  execute function public.set_updated_at();

-- 3. RLS：开启 + 不建任何 anon/authenticated 策略（默认 deny），仅 service_role 可访问
alter table public.staff_directory enable row level security;

-- 4. 权限收紧：撤销 anon / authenticated 的表级权限（自托管 Supabase 默认
--    会对 public 新表授权给 anon/authenticated，必须显式收回）；
--    仅授予 service_role（RLS 对 service_role 默认绕过，此 grant 为显式声明）
revoke all on public.staff_directory from anon, authenticated;
grant all on public.staff_directory to service_role;

-- 5. 补充：若需要给已注册用户"读自己那行"的能力（例如前端展示所属部门），
--    可取消注释下面的策略 —— 但按当前设计，注册时字段已复制进 user_profiles，
--    用户通过 user_profiles 的 RLS 读自己的信息即可，无需开放本表：
-- drop policy if exists "staff_directory_select_self" on public.staff_directory;
-- create policy "staff_directory_select_self"
--   on public.staff_directory
--   for select
--   using (
--     exists (
--       select 1 from public.user_profiles p
--       where p.user_id = auth.uid()
--         and p.oa_account = staff_directory.oa_account
--     )
--   );
