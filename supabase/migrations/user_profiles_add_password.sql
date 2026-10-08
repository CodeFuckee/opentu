-- ============================================================
-- user_profiles：新增 password 字段
-- 记录用户 Supabase 账号的明文密码，便于开发者测试时直接登录测试账号
-- （注册/登录成功后由前端回写；沿用 newapi_password 的内网自托管先例）
--
-- ⚠️ 风险提示：明文密码属高敏数据。RLS 保证普通用户只能读写自己的行，
--    读取全部用户的密码需要 service_role / 数据库直连权限；
--    仅建议内网/测试环境使用，对外开放的生产环境应清空该列。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_profiles_add_password.sql
-- ============================================================

alter table public.user_profiles
  add column if not exists password text;  -- Supabase 账号密码（明文，注册/登录时由前端回写）

comment on column public.user_profiles.password is 'Supabase 账号密码（明文，注册/登录成功后由前端回写，供开发者测试登录用）';
