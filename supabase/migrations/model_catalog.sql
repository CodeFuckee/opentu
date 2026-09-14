-- ============================================================
-- model_catalog：云端模型目录（不发版上架/调整模型的运营通道）
--
-- 条目 id 必须与上游网关（new-api）的模型 ID 完全一致；
-- 前端按 id 覆盖同名的内置/运行时发现条目，仅覆盖目录级元数据。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/model_catalog.sql
-- ============================================================

create table if not exists public.model_catalog (
  id                text primary key,      -- 模型 ID（与网关一致，如 seedance-2.0-pro）
  type              text not null check (type in ('image', 'video', 'text', 'audio')),
  vendor            text not null default 'OTHER',
  label             text not null,
  short_label       text,
  short_code        text,
  description       text,
  is_vip            boolean not null default false,
  supports_tools    boolean not null default false,
  recommended_score integer,
  image_defaults    jsonb,                 -- { aspectRatio, width, height }
  video_defaults    jsonb,                 -- { duration, size, aspectRatio }
  tags              text[] not null default '{}',
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.model_catalog is '云端模型目录：前端启动时拉取 enabled 条目合并进模型选择器（remote > 运行时发现 > 静态内置）';
comment on column public.model_catalog.id is '模型 ID，必须与上游网关（new-api）的模型 ID 完全一致';
comment on column public.model_catalog.type is '模型类型：image / video / text / audio';
comment on column public.model_catalog.vendor is '厂商枚举值（前端 ModelVendor），未知厂商填 OTHER';
comment on column public.model_catalog.label is '选择器展示名';
comment on column public.model_catalog.short_label is '紧凑展示名（可空）';
comment on column public.model_catalog.short_code is '@ 选择器短码（可空，缺省由前端按模型 ID 生成）';
comment on column public.model_catalog.description is '描述文案（可空）';
comment on column public.model_catalog.is_vip is '是否 VIP/推荐标记';
comment on column public.model_catalog.supports_tools is '是否支持 Agent 工具调用（文本模型）';
comment on column public.model_catalog.recommended_score is '排序分（越大越靠前，可空）';
comment on column public.model_catalog.image_defaults is '图片默认参数 { aspectRatio, width, height }';
comment on column public.model_catalog.video_defaults is '视频默认参数 { duration, size, aspectRatio }';
comment on column public.model_catalog.tags is '参数兼容匹配标签';
comment on column public.model_catalog.enabled is '停用开关：false 后前端不再下发该条目';

-- updated_at 自动更新（本迁移私有函数：不 CREATE OR REPLACE 共享的
-- set_updated_at()，避免因函数属主不同导致迁移失败，也不影响其他表）
create or replace function public.model_catalog_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists model_catalog_set_updated_at on public.model_catalog;
create trigger model_catalog_set_updated_at
  before update on public.model_catalog
  for each row
  execute function public.model_catalog_set_updated_at();

-- RLS：目录数据公开可读（未登录 BYOK 用户也需要），写入仅 service_role
alter table public.model_catalog enable row level security;

drop policy if exists "model_catalog_select_enabled_anon" on public.model_catalog;
create policy "model_catalog_select_enabled_anon"
  on public.model_catalog
  for select
  using (enabled = true);
