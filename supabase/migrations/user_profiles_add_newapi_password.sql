-- ============================================================
-- user_profiles：新增 newapi_password 字段
-- 存储 new-api 平台用户密码（Edge Function 创建 new-api 用户时生成，
-- 后续登录建令牌/续期时使用；自托管内网部署，非公开明文风险）
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_profiles_add_newapi_password.sql
-- ============================================================

alter table public.user_profiles
  add column if not exists newapi_password text;  -- new-api 平台用户密码

comment on column public.user_profiles.newapi_password is 'new-api 平台用户密码（Edge Function 管理）';
