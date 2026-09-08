-- ============================================================
-- generation_usage：生图月度额度管控
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage.sql
--
-- 设计要点：
--   * 周期 = 自然月（Asia/Shanghai），惰性计算，无需定时任务
--   * 扣减为单语句原子操作，超限则不生效
--   * 限额读取顺序：部门覆盖 → 全局配置(image_monthly_quota_default) → 缺省 200
--   * 函数仅授予 service_role 执行；前端一律经 ai-proxy 边缘函数访问
--
-- ⚠️ 用户级额度覆盖（user_quota_configs）由 generation_usage_user_override.sql
--    追加；若重新执行本文件，会回退该文件的函数改动，需再执行：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage_user_override.sql
-- ============================================================

-- 1. 用量表：每用户每月一行
create table if not exists public.generation_usage (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  period      date        not null,                 -- 该自然月首日（本地时区）
  used_count  integer     not null default 0 check (used_count >= 0),
  updated_at  timestamptz not null default now(),
  primary key (user_id, period)
);

comment on table public.generation_usage is '生图月度用量（每用户每自然月一行）';

drop trigger if exists generation_usage_set_updated_at on public.generation_usage;
create trigger generation_usage_set_updated_at
  before update on public.generation_usage
  for each row
  execute function public.set_updated_at();

-- 2. RLS：用户只能查看自己的用量行；写入口一律走 service_role（无 insert/update/delete 策略）
alter table public.generation_usage enable row level security;

drop policy if exists "generation_usage_select_own" on public.generation_usage;
create policy "generation_usage_select_own"
  on public.generation_usage
  for select
  using (auth.uid() = user_id);

revoke all on public.generation_usage from anon, authenticated;
grant select on public.generation_usage to authenticated;

-- ============================================================
-- 3. 配额函数（SECURITY DEFINER，绕过 RLS；仅 service_role 可执行）
-- ============================================================

-- 当前自然月首日（以本地时区为准）
create or replace function public.current_quota_period()
returns date
language sql
stable
as $$
  select date_trunc('month', now() at time zone 'Asia/Shanghai')::date;
$$;

-- 读取限额：部门覆盖 image_monthly_quota_{department}
--          → 全局 image_monthly_quota_default
--          → 缺省 200
-- p_department 为 null 时跳过部门级查找。
create or replace function public.resolve_image_quota_limit(p_department text)
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

-- 查询用户所属部门（user_profiles 表保证存在；异常时返回 null）
create or replace function public.get_user_department(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_department text;
begin
  begin
    select department into v_department from user_profiles where user_id = p_user_id limit 1;
  exception when undefined_table or undefined_object or others then
    v_department := null;
  end;
  return v_department;
end;
$$;

-- 额度总览：{ limit, used, remaining, period }
create or replace function public.get_image_quota(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  select used_count into v_used
    from generation_usage
    where user_id = p_user_id and period = current_quota_period()
    limit 1;

  v_used := coalesce(v_used, 0);
  return jsonb_build_object(
    'limit', resolve_image_quota_limit(get_user_department(p_user_id)),
    'used', v_used,
    'remaining', greatest(0, resolve_image_quota_limit(get_user_department(p_user_id)) - v_used),
    'period', current_quota_period()
  );
end;
$$;

-- 扣减额度（预扣）：单语句原子累加，超限不生效
-- 成功返回 {consumed:true,...}；失败返回 {consumed:false,...}
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

  v_limit := resolve_image_quota_limit(get_user_department(p_user_id));

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

-- 退回额度：上游失败/终态失败时调用，下限 0
create or replace function public.refund_image_quota(
  p_user_id uuid,
  p_count   integer default 1
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_count is null or p_count < 1 then
    return;
  end if;
  update generation_usage
     set used_count = greatest(0, used_count - least(p_count, 100))
   where user_id = p_user_id
     and period = current_quota_period();
end;
$$;

-- ============================================================
-- 4. 异步任务记账：提交成功后记录上游任务 id；终态失败时按行幂等退回
-- ============================================================

create table if not exists public.generation_task_bills (
  upstream_id text        not null primary key,   -- 上游任务 id（视频/异步图像/MJ）
  user_id     uuid        not null,
  period      date        not null,
  count       integer     not null default 1 check (count >= 1),
  refunded    boolean     not null default false,
  created_at  timestamptz not null default now()
);

comment on table public.generation_task_bills is '异步生图任务预扣记账（用于终态失败时一次性退回）';

alter table public.generation_task_bills enable row level security;
revoke all on public.generation_task_bills from anon, authenticated;

-- 记录已成功的异步任务预扣
create or replace function public.record_task_bill(
  p_user_id    uuid,
  p_upstream_id text,
  p_count      integer default 1
)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into generation_task_bills (upstream_id, user_id, period, count)
  values (p_upstream_id, p_user_id, current_quota_period(), greatest(coalesce(p_count,1),1))
  on conflict (upstream_id) do nothing;
$$;

-- 终态失败时一次性退回：返回是否本次发生了退回
create or replace function public.refund_task_bill(p_upstream_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_row generation_task_bills;
begin
  select * into v_row
    from generation_task_bills
    where upstream_id = p_upstream_id and refunded = false
    limit 1;

  if not found then
    return false;
  end if;

  update generation_task_bills
     set refunded = true
   where upstream_id = v_row.upstream_id
     and refunded = false;

  perform refund_image_quota(v_row.user_id, v_row.count);
  return true;
end;
$$;

-- 5. 仅 service_role 可执行配额函数（经 ai-proxy 访问）
revoke all on function public.current_quota_period()             from anon, authenticated;
revoke all on function public.resolve_image_quota_limit(text)    from anon, authenticated;
revoke all on function public.get_user_department(uuid)          from anon, authenticated;
revoke all on function public.get_image_quota(uuid)              from anon, authenticated;
revoke all on function public.consume_image_quota(uuid,integer)  from anon, authenticated;
revoke all on function public.refund_image_quota(uuid,integer)   from anon, authenticated;
revoke all on function public.record_task_bill(uuid,text,integer) from anon, authenticated;
revoke all on function public.refund_task_bill(text)              from anon, authenticated;
