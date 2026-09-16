-- ============================================================
-- user_roles_is_admin：用户角色与管理员判定（2026-09-16）
--
-- 目标（评审待确认项 C1/C2 的根治）：
--   1. user_profiles 增加 role 列（'admin' = 管理员，NULL = 普通用户）；
--   2. 收紧 user_profiles 写权限：客户端不再能 insert/update/delete 自己的行
--      （原 RLS 允许整行自写，若不收权，用户可"删行重插 role='admin'"自提权）；
--      写路径本就全部走 service_role 边缘函数（sync-staff-profile / newapi-key）；
--   3. 统一管理员判定 is_admin() RPC：role 列优先，configs 历史名单
--      （TEMPLATE_CRAWLER_ADMINS / TASK_MONITOR_ADMINS，逗号分隔 oa 账号）兼容回退；
--      看板 dashboard-stats、爬虫 template-crawler、监控 task-monitor 全部切到它；
--   4. 存量管理员自动迁移：现有 configs 名单中的 oa 账号批量刷成 role='admin'。
--
-- 用法（自托管 Supabase，必须以表属主 supabase_admin 执行——经 Studio/低权限
-- 连接会报 `42501: must be owner of table user_profiles`）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_roles_is_admin.sql
--
-- 任命/撤销管理员（此后唯一入口）：
--   update public.user_profiles set role='admin'  where oa_account='someone';
--   update public.user_profiles set role=null     where oa_account='someone';
--
-- 验证：
--   select oa_account, role from public.user_profiles where role='admin';
--   # 以普通用户 JWT 调用应返回 false，管理员 JWT 返回 true：
--   curl -s -X POST $SUPABASE_URL/rest/v1/rpc/is_admin \
--     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $USER_JWT"
-- ============================================================

-- 0. 属主自检：非属主执行立即给出可操作的报错（alter/revoke/trigger 都需要属主）
do $$
declare owner_name text;
begin
  select tableowner into owner_name
  from pg_tables where schemaname = 'public' and tablename = 'user_profiles';
  if owner_name is distinct from current_user then
    raise exception '当前连接角色 % 不是 user_profiles 的属主（属主为 %），请在服务器上执行: docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_roles_is_admin.sql',
      current_user, coalesce(owner_name, '?');
  end if;
end $$;

-- 1. 角色列（NULL = 普通用户；'admin' = 管理员；预留 'user' 显式值）
alter table public.user_profiles add column if not exists role text;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_profiles_role_check' and conrelid = 'public.user_profiles'::regclass
  ) then
    alter table public.user_profiles
      add constraint user_profiles_role_check check (role is null or role in ('admin', 'user'));
  end if;
end $$;

comment on column public.user_profiles.role is '平台角色：NULL=普通用户；admin=管理员（仅 service_role/DBA 可写，见 is_admin()）';

-- 2. 收权：客户端角色只能读自己的行；写路径全走 service_role
--    （原 user_profiles.sql:73 曾授予 insert/update/delete，删除行重插可自提权）
revoke insert, update, delete on public.user_profiles from anon, authenticated;

-- 3. 纵深防御触发器：即便未来误授权，用户 JWT 上下文也写不进 role
--    （无 JWT 的 DBA 直连 SQL 与 service_role 请求不受影响）
create or replace function public.guard_user_profiles_role()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') in ('authenticated', 'anon') then
    new.role := null;
  end if;
  return new;
end;
$$;

drop trigger if exists user_profiles_guard_role on public.user_profiles;
create trigger user_profiles_guard_role
  before insert or update of role on public.user_profiles
  for each row
  execute function public.guard_user_profiles_role();

-- 4. 统一管理员判定（安全定义者：读表不受 RLS 限制，但以调用者 JWT 的 auth.uid() 为准）
--    判定顺序：role 列 → configs 历史名单回退；任何异常 fail-closed 返回 false。
create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  has_role boolean;
  in_list  boolean;
begin
  if auth.uid() is null then
    return false;
  end if;

  select exists (
    select 1 from public.user_profiles up
    where up.user_id = auth.uid() and up.role = 'admin'
  ) into has_role;
  if coalesce(has_role, false) then
    return true;
  end if;

  -- 兼容回退：历史 configs 名单（逗号分隔 oa 账号，即邮箱前缀）
  begin
    select exists (
      select 1
      from public.user_profiles up
      cross join public.configs c
      where up.user_id = auth.uid()
        and c.key in ('TEMPLATE_CRAWLER_ADMINS', 'TASK_MONITOR_ADMINS')
        and exists (
          select 1
          from unnest(string_to_array(c.value, ',')) as lst(acc)
          where length(trim(lst.acc)) > 0
            and lower(trim(lst.acc)) = lower(trim(coalesce(up.oa_account, '')))
        )
    ) into in_list;
    return coalesce(in_list, false);
  exception when others then
    -- configs 表不存在等异常：回退判定失效即视为非管理员（fail-closed）
    return false;
  end;
end;
$$;

revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
-- 属主钉到 supabase_admin：security definer 函数若被低权限角色持有，
-- 会因读不到 user_profiles/configs 使 RPC 全部报错（管理员也会被拒）
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    alter function public.is_admin() owner to supabase_admin;
  end if;
end $$;

-- 5. 存量管理员迁移：把现有 configs 名单中的 oa 账号刷成 role='admin'
--    （configs 表缺失时仅告警跳过，role 判定此后以手工 SQL 任命为准）
do $$
begin
  update public.user_profiles up
  set role = 'admin', updated_at = now()
  where up.role is distinct from 'admin'
    and exists (
      select 1 from public.configs c
      where c.key in ('TEMPLATE_CRAWLER_ADMINS', 'TASK_MONITOR_ADMINS')
        and exists (
          select 1
          from unnest(string_to_array(c.value, ',')) as lst(acc)
          where length(trim(lst.acc)) > 0
            and lower(trim(lst.acc)) = lower(trim(coalesce(up.oa_account, '')))
        )
    );
  raise notice '存量管理员迁移完成，当前管理员：%',
    (select coalesce(string_agg(oa_account, ','), '（无）') from public.user_profiles where role = 'admin');
exception
  when others then
    raise notice '存量管理员迁移跳过（configs 表不可用）：%', sqlerrm;
end $$;
