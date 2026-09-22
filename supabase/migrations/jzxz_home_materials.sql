-- ============================================================
-- jzxz_home_materials：建筑学长家居库产品模型爬取归档
--
-- 用法（自托管 Supabase，本机执行）：
--   cat supabase/migrations/jzxz_home_materials.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 设计要点：
--   * 本机 selenium 爬虫（scripts/jzxz-home-crawler.py）遍历家居库
--     product_material_item，进入"查看详情"采集名称/品类/标签/尺寸，
--     左侧视图图片与 glb 模型转存公开桶 jzxz-home-materials，
--     元数据 upsert 到本表（service_role 写入，绕过 RLS）
--   * source_id = 上游图片 URL 内 UUID 文件名（稳定，upsert 键）
--   * 桶公开读：内网 HTTP 前端可直接用 /object/public/ 直链
--   * RLS：表仅登录用户可读；写只走 service_role
-- ============================================================

-- 1. 产品模型表
create table if not exists public.jzxz_home_materials (
  id                uuid primary key default gen_random_uuid(),
  source_id         text not null,                  -- 上游唯一标识（图片 URL UUID）
  name              text,                           -- 名称
  category          text,                           -- 品类
  tags              text[] default '{}',            -- 标签（数组）
  size_text         text,                           -- 尺寸（上游原文）
  image_paths       jsonb default '[]'::jsonb,      -- 视图图片桶内路径列表
  image_total_bytes bigint default 0,               -- 图片总字节数
  glb_path          text,                           -- glb 模型桶内路径
  glb_bytes         bigint default 0,               -- glb 字节数
  glb_name          text,                           -- glb 上游文件名（若有）
  source_url        text,                           -- 上游图片地址（调试用）
  raw               jsonb,                          -- 详情页文本快照（调试/回溯）
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_id)
);
create index if not exists jzxz_home_materials_category_idx
  on public.jzxz_home_materials (category);

comment on table public.jzxz_home_materials
  is '建筑学长家居库产品模型爬取归档（本机 selenium 爬虫写入）';
comment on column public.jzxz_home_materials.source_id is '上游素材唯一标识（upsert 键）';
comment on column public.jzxz_home_materials.glb_path is 'glb 模型在 jzxz-home-materials 桶内路径';

-- 2. updated_at 自动更新触发器（复用 set_updated_at）
drop trigger if exists jzxz_home_materials_set_updated_at on public.jzxz_home_materials;
create trigger jzxz_home_materials_set_updated_at
  before update on public.jzxz_home_materials
  for each row
  execute function public.set_updated_at();

-- 3. RLS：登录用户可读；写仅 service_role（爬虫）
alter table public.jzxz_home_materials enable row level security;
drop policy if exists "jzxz_home_materials_select_authenticated"
  on public.jzxz_home_materials;
create policy "jzxz_home_materials_select_authenticated"
  on public.jzxz_home_materials
  for select
  to authenticated
  using (true);

-- 4. 公开读桶
insert into storage.buckets (id, name, public)
values ('jzxz-home-materials', 'jzxz-home-materials', true)
on conflict (id) do nothing;
