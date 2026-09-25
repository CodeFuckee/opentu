-- ============================================================
-- jzxz_materials 增量：同一素材文件可挂多个分类（多分类成员）
--
-- 用法（自托管 Supabase，本机执行）：
--   cat supabase/migrations/jzxz_materials_multi_category.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 背景：建筑学长站点跨分类复用同一批素材文件（实证：配景库"舞台构建装置"
-- 的全部条目与 室内家具/办公桌 等已有行同文件）。原 unique(source_id) 使
-- 文件只能归首次遇到的分类，站点侧的分类视图无法在 UI 呈现。改为
-- unique(source_id, category)：爬虫遇到「同文件、新分类」时补一行，
-- 桶内文件路径复用既有行，不产生重复存储。
-- ============================================================

alter table public.jzxz_materials
  drop constraint jzxz_materials_source_id_key;
alter table public.jzxz_materials
  add constraint jzxz_materials_source_id_category_key unique (source_id, category);

comment on constraint jzxz_materials_source_id_category_key
  on public.jzxz_materials
  is '同一素材文件可出现在多个分类（跨分类复用），按 (source_id, category) 唯一';
