-- ai_templates：AI 模板中心数据表（来源：add-template-gallery 变更）
-- 幂等可重跑；在自托管 supabase-db 容器执行：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/ai_templates.sql

-- ============ 模板主表 ============
create table if not exists ai_templates (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'jzxz',             -- 来源站标识（预留多来源）
  source_id text not null,                         -- 来源站 templateId
  category text,                                   -- 一级分类（如 效果渲染）
  catalogs jsonb default '[]',                     -- 原始分类路径 [["效果渲染","景观渲染"]]
  title text not null,
  prompt text,                                     -- 完整提示词（模板核心）
  template_version text,                           -- 来源模板引擎（如 GPT_IMAGE_2）
  cover_storage_path text,                         -- huabu bucket 内转存路径
  source_url text,                                 -- 原文/封面链接（署名与跳转）
  extra jsonb default '{}',                        -- 其余字段（resolution/aspectRatio/效果图等）
  likes int default 0,                             -- 来源收藏数
  views int default 0,                             -- 来源浏览数
  source_use_count int default 0,                  -- 来源使用数
  usage_count int default 0,                       -- 本平台使用计数
  content_hash text,                               -- 增量对比哈希
  status text not null default 'active',           -- active | hidden
  crawled_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(source, source_id)
);

create index if not exists ai_templates_category_idx on ai_templates (category) where status = 'active';
create index if not exists ai_templates_status_idx on ai_templates (status, usage_count desc);

-- ============ 使用记录表 ============
create table if not exists template_usage_log (
  id bigint generated always as identity primary key,
  template_id uuid not null references ai_templates(id),
  user_id uuid not null,
  used_at timestamptz default now()
);

create index if not exists template_usage_log_template_idx on template_usage_log (template_id);

-- ============ RLS ============
alter table ai_templates enable row level security;
drop policy if exists "read active templates" on ai_templates;
create policy "read active templates" on ai_templates
  for select to authenticated using (status = 'active');

alter table template_usage_log enable row level security;
drop policy if exists "insert own usage" on template_usage_log;
create policy "insert own usage" on template_usage_log
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "read own usage" on template_usage_log;
create policy "read own usage" on template_usage_log
  for select to authenticated using (user_id = auth.uid());

-- ============ 使用计数 RPC（原子：插记录 + 计数自增） ============
create or replace function use_template(p_template_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count int;
begin
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;
  insert into template_usage_log(template_id, user_id) values (p_template_id, auth.uid());
  update ai_templates
    set usage_count = usage_count + 1, updated_at = now()
    where id = p_template_id and status = 'active'
    returning usage_count into new_count;
  return coalesce(new_count, 0);
end;
$$;

-- service_role 全量权限（爬虫经 PostgREST service_role 写入）
grant all on ai_templates to service_role;
grant all on template_usage_log to service_role;
grant execute on function use_template(uuid) to authenticated;

-- ============ 2026-09-15 追加：封面公开 URL（images 公开桶） ============
alter table ai_templates add column if not exists cover_public_url text;
