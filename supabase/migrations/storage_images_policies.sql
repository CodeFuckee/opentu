-- ============================================================
-- storage.images 桶策略：允许登录用户上传、公开读取、作者改删
--
-- 背景：feedbackland:redeploy 只创建 public 桶（无任何策略），
-- Supabase Storage 的 public 仅指对象可公开读取；写入仍受
-- storage.objects 的 RLS 约束，缺策略时登录用户上传报
-- 403 "new row violates row-level security policy"。
--
-- 幂等：可重复执行。
-- 用法（自托管 Supabase 宿主机）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/storage_images_policies.sql
-- ============================================================

-- 上传：仅登录用户（opentu 画布用户 / Feedbackland 登录用户均为 authenticated）
drop policy if exists "images_authenticated_insert" on storage.objects;
create policy "images_authenticated_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'images');

-- 读取：公开桶，任何人可读（配合 getPublicUrl 直链访问）
drop policy if exists "images_public_select" on storage.objects;
create policy "images_public_select"
  on storage.objects for select to public
  using (bucket_id = 'images');

-- 更新/删除：仅对象所有者（上传者本人）
drop policy if exists "images_owner_update" on storage.objects;
create policy "images_owner_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'images' and owner = auth.uid());

drop policy if exists "images_owner_delete" on storage.objects;
create policy "images_owner_delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'images' and owner = auth.uid());
