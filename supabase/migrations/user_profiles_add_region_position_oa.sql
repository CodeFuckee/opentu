-- ============================================================
-- user_profiles：新增 区域(region) / 岗位(position) / OA账号(oa_account) 字段
--
-- 增量迁移（在已部署的 user_profiles 表上追加字段，幂等可重跑）
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_profiles_add_region_position_oa.sql
-- ============================================================

-- 1. 追加字段（IF NOT EXISTS 保证幂等）
alter table public.user_profiles
  add column if not exists region      text,  -- 区域
  add column if not exists position    text,  -- 岗位
  add column if not exists oa_account  text;  -- OA账号

comment on column public.user_profiles.region is '区域';
comment on column public.user_profiles.position is '岗位';
comment on column public.user_profiles.oa_account is 'OA账号';

-- 2. 确认 updated_at 触发器仍存在（若表是新装的，基础脚本已建）
--    这里不重复创建，仅幂等校验列存在即可
