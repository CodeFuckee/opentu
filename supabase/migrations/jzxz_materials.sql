-- ============================================================
-- jzxz_materials：建筑学长贴图素材库爬取归档
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/jzxz_materials.sql
--
-- 设计要点：
--   * 本机 selenium 爬虫（scripts/jzxz-material-crawler.py）每日定时抓取
--     建筑学长贴图库（家居/植物/配景），图片转存公开桶 jzxz-materials，
--     元数据 upsert 到本表（service_role 写入，绕过 RLS）
--   * source_id 唯一（上游素材标识）；content_hash 用于去重与增量判定
--   * 桶公开读：贴图选择器前端可直接用 /object/public/ 直链
--   * RLS：表仅登录用户可读；写只走 service_role
-- ============================================================

-- 1. 素材表
create table if not exists public.jzxz_materials (
  id            uuid primary key default gen_random_uuid(),
  source_id     text not null,                     -- 上游素材唯一标识
  gallery       text,                              -- 顶级库：家居库/植物库/配景库
  category      text,                              -- 二级分类（仅配景库有，如 植物配景）
  tag           text,                              -- 三级 tag（归一化为 chip 文本，如 绿树）
  name          text,                              -- 素材名（如 F-Affair）
  width         integer,
  height        integer,
  preview_path  text,                              -- 桶内预览图路径（jzxz-materials 桶）
  file_path     text,                              -- 桶内原图路径
  source_url    text,                              -- 上游 CDN 原始地址（调试用）
  content_hash  text,                              -- 图片字节哈希（去重/增量判定）
  extra         jsonb,                             -- 上游响应其他字段快照
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source_id)
);
create index if not exists jzxz_materials_category_idx on public.jzxz_materials (category);
create index if not exists jzxz_materials_tag_idx on public.jzxz_materials (tag);
create index if not exists jzxz_materials_gallery_idx on public.jzxz_materials (gallery);

comment on table public.jzxz_materials is '建筑学长贴图素材库爬取归档（本机 selenium 爬虫写入）';
comment on column public.jzxz_materials.source_id is '上游素材唯一标识（upsert 键）';
comment on column public.jzxz_materials.content_hash is '图片内容哈希，用于去重与增量判定';

-- 2. updated_at 自动更新触发器（复用 user_profiles.sql 定义的 set_updated_at）
drop trigger if exists jzxz_materials_set_updated_at on public.jzxz_materials;
create trigger jzxz_materials_set_updated_at
  before update on public.jzxz_materials
  for each row
  execute function public.set_updated_at();

-- 3. RLS：登录用户可读；写仅 service_role（爬虫）
alter table public.jzxz_materials enable row level security;
drop policy if exists "jzxz_materials_select_authenticated" on public.jzxz_materials;
create policy "jzxz_materials_select_authenticated"
  on public.jzxz_materials
  for select
  to authenticated
  using (true);

-- 4. 公开读桶 jzxz-materials（贴图选择器直链 /object/public/）
insert into storage.buckets (id, name, public)
values ('jzxz-materials', 'jzxz-materials', true)
on conflict (id) do nothing;

-- 5. 增量升级（2026-09-20）：gallery 列 + category 放宽可空 + 存量 tag 归一化
alter table public.jzxz_materials add column if not exists gallery text;
alter table public.jzxz_materials alter column category drop not null;
update public.jzxz_materials set tag = regexp_replace(regexp_replace(tag, '^免抠-', ''), '。*$')
  where tag like '免抠-%' or tag like '%.';
update public.jzxz_materials set gallery = '配景库'
  where gallery is null and category in
  ('植物配景','人物配景','交通配景','室内家具','室内物品','建筑构件','城市建筑','景观小品','动物配景','自然环境','总平素材');
