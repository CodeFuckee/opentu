-- ============================================================
-- generation_usage_user_override：生图月度额度的"用户级"覆盖
--
-- 用法（自托管 Supabase，需在 generation_usage.sql 之后执行）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage_user_override.sql
--
-- 设计要点：
--   * 限额解析顺序变更为：
--       用户覆盖(user_quota_configs) → 部门覆盖(image_monthly_quota_{department})
--       → 全局配置(image_monthly_quota_default) → 缺省 200
--   * 管理员在 Supabase Dashboard 的 Table Editor 里对 user_quota_configs
--     增/删/改行即可即时生效（每次生图/查额度都实时解析，无需重启）；
--     删除某用户的行 = 回退到部门/全局默认。
--   * ⚠️ 若之后重新执行 generation_usage.sql，会回退本文件的函数改动，
--     需要再执行一次本文件。
-- ============================================================

-- 1. 用户级配额覆盖表：需要特殊额度的用户一行
create table if not exists public.user_quota_configs (
  user_id     uuid        not null primary key references auth.users (id) on delete cascade,
  quota_limit integer     not null check (quota_limit > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.user_quota_configs is '生图月度额度用户级覆盖（优先级最高；删行=回退默认）';
comment on column public.user_quota_configs.quota_limit is '该用户每月生图上限（张），覆盖部门/全局配置';

drop trigger if exists user_quota_configs_set_updated_at on public.user_quota_configs;
create trigger user_quota_configs_set_updated_at
  before update on public.user_quota_configs
  for each row
  execute function public.set_updated_at();

-- 2. RLS：不授予任何客户端角色读写（管理员经 Dashboard/表属主身份编辑，
--    服务端经 service_role RPC 访问，不走本表直查）
alter table public.user_quota_configs enable row level security;
revoke all on public.user_quota_configs from anon, authenticated;

-- ============================================================
-- 3. 限额解析：增加用户级覆盖（优先级最高）
--    注意：签名从 (text) 变为 (uuid, text)，旧函数在文末删除
-- ============================================================
create or replace function public.resolve_image_quota_limit(
  p_user_id    uuid,
  p_department text
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_value    text;
  v_limit    integer;
  v_present  boolean;
begin
  -- 用户级覆盖：user_quota_configs 有行且 >0 时直接生效
  begin
    select quota_limit into v_limit
      from user_quota_configs
      where user_id = p_user_id
      limit 1;
  exception when undefined_table or undefined_object or others then
    v_limit := null;
  end;
  if coalesce(v_limit, 0) > 0 then
    return v_limit;
  end if;

  -- department_configs 表可能尚未部署（可选表），缺失时静默跳过部门级查找
  select count(*) > 0 into v_present
    from information_schema.tables
    where table_schema = 'public' and table_name = 'department_configs';

  if v_present and p_department is not null and p_department <> '' then
    begin
      select value into v_value
        from department_configs
        where key = 'image_monthly_quota_' || p_department
        limit 1;
      if v_value ~ '^[0-9]+$' then
        return v_value::integer;
      end if;
    exception when undefined_table or undefined_object or others then
      v_value := null;
    end;
  end if;

  if v_present then
    begin
      select value into v_value
        from department_configs
        where key = 'image_monthly_quota_default'
        limit 1;
      begin
        v_limit := v_value::integer;
      exception when others then
        v_limit := null;
      end;
    exception when undefined_table or undefined_object or others then
      v_limit := null;
    end;
  end if;

  if coalesce(v_limit, 0) > 0 then
    return v_limit;
  end if;

  return 200;
end;
$$;

-- 4. 重构引用方：改为传入 user_id 的两参解析
create or replace function public.get_image_quota(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used  integer;
  v_limit integer;
begin
  select used_count into v_used
    from generation_usage
    where user_id = p_user_id and period = current_quota_period()
    limit 1;

  v_used := coalesce(v_used, 0);
  v_limit := resolve_image_quota_limit(p_user_id, get_user_department(p_user_id));
  return jsonb_build_object(
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(0, v_limit - v_used),
    'period', current_quota_period()
  );
end;
$$;

create or replace function public.consume_image_quota(
  p_user_id uuid,
  p_count   integer default 1
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_limit  integer;
  v_used   integer;
begin
  if p_count is null or p_count < 1 then
    p_count := 1;
  end if;
  p_count := least(p_count, 10);

  v_limit := resolve_image_quota_limit(p_user_id, get_user_department(p_user_id));

  -- 有行：条件累加（累加后须 ≤ 限额）
  update generation_usage
     set used_count = used_count + p_count
   where user_id = p_user_id
     and period = current_quota_period()
     and used_count + p_count <= v_limit
  returning used_count into v_used;

  if v_used is not null then
    return jsonb_build_object(
      'consumed', true, 'used', v_used, 'limit', v_limit,
      'remaining', v_limit - v_used
    );
  end if;

  -- 无行：插入（并发冲突时由下面的重查兜底）
  begin
    insert into generation_usage (user_id, period, used_count)
    values (p_user_id, current_quota_period(), p_count)
    returning used_count into v_used;
    return jsonb_build_object(
      'consumed', true, 'used', v_used, 'limit', v_limit,
      'remaining', v_limit - v_used
    );
  exception when unique_violation then
    update generation_usage
       set used_count = used_count + p_count
     where user_id = p_user_id
       and period = current_quota_period()
       and used_count + p_count <= v_limit
    returning used_count into v_used;
    if v_used is not null then
      return jsonb_build_object(
        'consumed', true, 'used', v_used, 'limit', v_limit,
        'remaining', v_limit - v_used
      );
    end if;
  end;

  -- 到这里说明超出限额或行已存在且越限：报告当前用量
  select used_count into v_used
    from generation_usage
    where user_id = p_user_id and period = current_quota_period()
    limit 1;

  return jsonb_build_object(
    'consumed', false,
    'used', coalesce(v_used, 0), 'limit', v_limit,
    'remaining', greatest(0, v_limit - coalesce(v_used, 0))
  );
end;
$$;

-- 5. 删除旧的单参解析函数（避免误用旧解析链）
drop function if exists public.resolve_image_quota_limit(text);

-- 6. 管理员总览视图（仅 Dashboard/表属主与 service_role 可读；
--    不授予 anon/authenticated，避免泄露全量用户信息）
create or replace view public.user_quota_overview as
select
  p.user_id,
  u.email,
  p.oa_account,
  p.department,
  q.quota_limit                                                as override_limit,
  coalesce(g.used_count, 0)                                    as used_count,
  public.resolve_image_quota_limit(p.user_id, p.department)    as effective_limit,
  greatest(0,
    public.resolve_image_quota_limit(p.user_id, p.department)
    - coalesce(g.used_count, 0))                               as remaining,
  public.current_quota_period()                                as period
from public.user_profiles p
join auth.users u on u.id = p.user_id
left join public.user_quota_configs q on q.user_id = p.user_id
left join public.generation_usage g
  on g.user_id = p.user_id and g.period = public.current_quota_period();

comment on view public.user_quota_overview is '生图额度管理员总览（用户覆盖/部门/全局解析结果与当月用量）；仅管理员可读';
revoke all on public.user_quota_overview from anon, authenticated;

-- 7. 仅 service_role 可执行配额函数（经 ai-proxy 访问）
revoke all on function public.resolve_image_quota_limit(uuid, text) from anon, authenticated;
revoke all on function public.get_image_quota(uuid)                 from anon, authenticated;
revoke all on function public.consume_image_quota(uuid, integer)    from anon, authenticated;
