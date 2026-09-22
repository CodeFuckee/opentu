-- ============================================================
-- jzxz_home_materials 增量：glb_attempts 重试计数
--
-- 用法（自托管 Supabase，本机执行）：
--   cat supabase/migrations/jzxz_home_materials_glb_attempts.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 背景：部分商品可能没有 glb 模型，glb_path 为空的行会被爬虫每轮重采，
-- 永远跳不过。加计数列：连续 3 次仍未拿到 glb 即视为无 glb，不再重试。
-- ============================================================

alter table public.jzxz_home_materials
  add column if not exists glb_attempts integer not null default 0;

comment on column public.jzxz_home_materials.glb_attempts
  is 'glb 获取失败累计次数（成功后清零；>=3 视为无 glb 不再重试）';
