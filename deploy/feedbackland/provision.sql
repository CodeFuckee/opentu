-- =============================================================================
-- Feedbackland 生产数据准备（一次性，需在现有自建 Supabase 实例上执行）
-- 目标实例：10.37.80.25:8021（网关）/ 10.37.80.25:5432（Postgres）
-- 原则：增量操作，不影响 opentu 现有对象；回滚 = 删除 feedbackland 库。
--
-- 执行人：需要实例 Postgres 超级用户（如 postgres / supabase_admin）凭据，
-- 建议在部署机（10.37.80.25）上通过 docker exec 或 psql 执行。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) 创建独立数据库（应用表与 opentu 完全隔离）
--    psql -h 10.37.80.25 -U postgres -c "CREATE DATABASE feedbackland;"
--    注意：CREATE DATABASE 不能在事务块内执行。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 2) 在 feedbackland 库执行应用表结构（feedbackland/db/schema.sql 的
--    应用表部分 —— 从文件开头到最后一个 FOREIGN KEY，不含末尾 storage 段）：
--    psql -h 10.37.80.25 -U postgres -d feedbackland -f <schema-apptables.sql>
--    （schema.sql 中的 storage.buckets / storage.objects 语句属于实例默认库，
--      不要在本库执行。）
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 3) 在实例默认库（postgres）创建 images 桶与匿名上传策略（增量，幂等；
--    不影响 opentu 的 huabu / yue-sync 桶）
-- ---------------------------------------------------------------------------
INSERT INTO "storage"."buckets" (id, name, public)
VALUES ('images', 'images', true)
ON CONFLICT DO NOTHING;

CREATE POLICY "Allow anon uploads"
ON "storage"."objects"
FOR INSERT
TO "public"
WITH CHECK (bucket_id = 'images');
-- 若策略已存在（重复执行），先执行：DROP POLICY IF EXISTS "Allow anon uploads" ON "storage"."objects";

-- ---------------------------------------------------------------------------
-- 4) Supabase Auth 设置（管理界面或 SQL）：
--    关闭"邮箱确认"（Confirm email），否则注册后不会自动登录
--    （Feedbackland 的注册流程期望 signUp 后立即建立会话）。
-- ---------------------------------------------------------------------------
