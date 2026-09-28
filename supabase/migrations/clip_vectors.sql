-- ============================================================
-- 以图搜图向量基建(#61):pgvector + asset_vectors + 相似检索 RPC
--
-- 用法(自托管 Supabase 宿主机):
--   cat supabase/migrations/clip_vectors.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 设计(docs/clip-image-search-design.md):
--   * 统一向量表 asset_vectors:四库(贴图/家居/植物/模板封面)一图一行,
--     家居/植物多视图每图一条向量,检索时按 (asset_type, asset_id) 去重取最高分
--   * CLIP ViT-B/32,512 维,int8;model_version 列锁版本(换模型=全量重刷)
--   * 批量写入走 service_role(本机离线脚本);读(检索)登录用户即可
--   * HNSW 余弦索引;pgvector 0.8.x
-- 幂等:可重复执行。
-- ============================================================

create extension if not exists vector;

-- 1. 向量表(复合主键 = 身份键:老版 PostgREST 的 PUT upsert 仅支持主键列
--    on_conflict(PGRST105),POST+resolution=merge-duplicates 实测对非主键
--    唯一约束不生效(23505),故以三列复合主键直连 upsert 语义)
create table if not exists public.asset_vectors (
  asset_type    text not null,   -- jzxz_materials / jzxz_home_materials / jzxz_plant_materials / ai_templates
  asset_id      text not null,   -- 原表 source_id(贴图/家居/植物)或 ai_templates.source_id
  image_url     text not null,   -- 该向量对应的公开桶直链(多视图素材一图一行)
  embedding     vector(512) not null,
  model_version text not null,   -- 'clip-vit-b32-int8-v1'
  updated_at    timestamptz not null default now(),
  primary key (asset_type, asset_id, image_url)
);

create index if not exists asset_vectors_embedding_hnsw
  on public.asset_vectors using hnsw (embedding vector_cosine_ops);

comment on table public.asset_vectors is '素材/模板图片的 CLIP 向量(以图搜图 #61;批量脚本写入,检索走 search_similar_assets)';
comment on column public.asset_vectors.model_version is '编码模型版本(换模型须全量重刷向量)';

-- 2. RLS:登录用户可读;写仅 service_role(批量脚本)
alter table public.asset_vectors enable row level security;
drop policy if exists "asset_vectors_select_authenticated" on public.asset_vectors;
create policy "asset_vectors_select_authenticated"
  on public.asset_vectors for select to authenticated
  using (true);

-- 3. 相似检索 RPC:向量 top-k → 按素材去重取最高分 → join 原表回元数据
create or replace function public.search_similar_assets(
  p_embedding vector(512),
  p_asset_types text[] default null,
  p_match_count int default 30
)
returns table (
  asset_type text,
  asset_id text,
  image_url text,
  name text,
  category text,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with candidates as (
    select v.asset_type, v.asset_id, v.image_url,
           1 - (v.embedding <=> p_embedding) as sim
    from asset_vectors v
    where p_asset_types is null or v.asset_type = any (p_asset_types)
    order by v.embedding <=> p_embedding
    limit greatest(p_match_count, 1) * 3
  ),
  dedup as (
    select distinct on (asset_type, asset_id)
      asset_type, asset_id, image_url, sim
    from candidates
    order by asset_type, asset_id, sim desc
  )
  select
    d.asset_type,
    d.asset_id,
    d.image_url,
    coalesce(m1.name, m2.name, m3.name, t.title) as name,
    coalesce(m1.category, m2.category, m3.category, t.category) as category,
    d.sim as similarity
  from dedup d
  left join jzxz_materials m1
    on d.asset_type = 'jzxz_materials' and m1.source_id = d.asset_id
  left join jzxz_home_materials m2
    on d.asset_type = 'jzxz_home_materials' and m2.source_id = d.asset_id
  left join jzxz_plant_materials m3
    on d.asset_type = 'jzxz_plant_materials' and m3.source_id = d.asset_id
  left join ai_templates t
    on d.asset_type = 'ai_templates' and t.source_id = d.asset_id
  order by d.sim desc
  limit greatest(p_match_count, 1);
$$;

grant execute on function public.search_similar_assets(vector(512), text[], int) to authenticated;

-- 4. 检索用只读视图(浏览器上传图后可选:查询向量以图搜模板,二期文搜图复用)
--    (暂无,保持最小面)
