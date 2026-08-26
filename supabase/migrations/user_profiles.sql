-- ============================================================
-- user_profiles：扩充 auth.users 字段的扩展表
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_profiles.sql
-- ============================================================

-- 1. 创建扩展表（一个用户对应一行）
create table if not exists public.user_profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  department  text,                          -- 部门
  apikey      text,                          -- API key
  region      text,                          -- 区域
  position    text,                          -- 岗位
  oa_account  text,                          -- OA账号
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.user_profiles is '用户扩展信息（部门、apikey、区域、岗位、OA账号 等）';
comment on column public.user_profiles.department is '部门';
comment on column public.user_profiles.apikey is 'API key';
comment on column public.user_profiles.region is '区域';
comment on column public.user_profiles.position is '岗位';
comment on column public.user_profiles.oa_account is 'OA账号';

-- 2. updated_at 自动更新触发器
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row
  execute function public.set_updated_at();

-- 3. 开启 RLS（行级安全）：用户只能读写自己的行
alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
  on public.user_profiles
  for select
  using (auth.uid() = user_id);

drop policy if exists "user_profiles_insert_own" on public.user_profiles;
create policy "user_profiles_insert_own"
  on public.user_profiles
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_profiles_update_own" on public.user_profiles;
create policy "user_profiles_update_own"
  on public.user_profiles
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_profiles_delete_own" on public.user_profiles;
create policy "user_profiles_delete_own"
  on public.user_profiles
  for delete
  using (auth.uid() = user_id);

-- 4. 授权给 anon / authenticated 角色（配合 RLS 使用）
grant select, insert, update, delete on public.user_profiles to anon, authenticated;

-- 5. 为既有用户补行（可选）：让已注册用户也有对应 profile 行
insert into public.user_profiles (user_id)
select id from auth.users
where not exists (select 1 from public.user_profiles p where p.user_id = auth.users.id);
