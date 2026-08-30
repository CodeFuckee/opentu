-- ============================================================
-- storage.objects `huabu` bucket RLS：按 OA 账号文件夹隔离（v2）
--
-- 背景（修复）：旧策略用 JWT 邮箱 @ 前缀比对路径首段，而前端上传路径的
--   首段优先取 user_profiles.oa_account（service.ts resolveUsername），两者
--   不一致的用户上传被 RLS 拒绝 → storage 返回 400 → file_paths 恒为空。
--
-- 本迁移（覆盖旧策略）：
--   1. 用户可访问「自己 OA 账号名称文件夹」下所有文件：
--      select / insert / update 允许（对象路径首段 == 当前用户清洗后的 oa_account）
--   2. 不允许 delete：不创建 delete 策略（RLS 默认拒绝），并显式 drop 旧 delete 策略
--   3. 用户名清洗与前端 sanitizeUsername 完全一致：
--      trim → lower → [^a-z0-9._-] 替换为 _ → 截断 64 字符
--   4. oa_account 缺失时回退 JWT 邮箱 @ 前缀（与前端 resolveUsername 一致）
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/task_submissions_huabu_rls_v2_oa_folder.sql
--   或在 Supabase Studio SQL 编辑器中整段执行
-- ============================================================

-- 0. 确保 bucket 存在（幂等；若曾手动建过则跳过）
insert into storage.buckets (id, name, public)
values ('huabu', 'huabu', false)
on conflict (id) do nothing;

-- 1. 当前用户的 huabu 归档文件夹名（清洗规则与前端 sanitizeUsername 一致）
--
-- security definer：读取 user_profiles 不受其 RLS 限制（该表 RLS 只放行本人行，
-- 但策略求值期间应与调用方表权限解耦，避免未来收紧 user_profiles RLS 时连带破坏 storage 策略）。
-- 返回 null（邮箱也不可用时）→ 策略比较为假 → 全部拒绝，与前端 username=null 跳过归档对齐。
create or replace function public.huabu_folder_name_for_current_user()
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (select left(
              regexp_replace(lower(trim(p.oa_account)), '[^a-z0-9._-]', '_', 'g'),
              64)
     from public.user_profiles p
     where p.user_id = auth.uid()
       and p.oa_account is not null
       and length(trim(p.oa_account)) > 0),
    (select lower(
              regexp_replace(
                split_part(auth.jwt() ->> 'email', '@', 1),
                '[^a-z0-9._-]', '_', 'g'))
     where (auth.jwt() ->> 'email') like '%@%'
       and length(split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1)) > 0)
  );
$$;

comment on function public.huabu_folder_name_for_current_user() is
  'huabu bucket 归档文件夹名：优先 user_profiles.oa_account，回退 JWT 邮箱前缀；清洗规则与前端 sanitizeUsername 一致（trim→lower→[^a-z0-9._-]→_→64）';

-- 2. 重建策略：drop 旧版（含 delete），新版不含 delete → delete 默认拒绝
drop policy if exists "task_submissions_huabu_insert" on storage.objects;
drop policy if exists "task_submissions_huabu_select" on storage.objects;
drop policy if exists "task_submissions_huabu_update" on storage.objects;
drop policy if exists "task_submissions_huabu_delete" on storage.objects;

-- 2.1 允许：上传到自己 OA 文件夹（input-*/output-* 均在其下）
drop policy if exists "task_submissions_huabu_insert_v2" on storage.objects;
create policy "task_submissions_huabu_insert_v2"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] = public.huabu_folder_name_for_current_user()
  );

-- 2.2 允许：读取/下载自己 OA 文件夹下的所有文件
drop policy if exists "task_submissions_huabu_select_v2" on storage.objects;
create policy "task_submissions_huabu_select_v2"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] = public.huabu_folder_name_for_current_user()
  );

-- 2.3 允许：更新自己 OA 文件夹下的文件（storage upsert 依赖 insert+update 双权限）
drop policy if exists "task_submissions_huabu_update_v2" on storage.objects;
create policy "task_submissions_huabu_update_v2"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] = public.huabu_folder_name_for_current_user()
  )
  with check (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] = public.huabu_folder_name_for_current_user()
  );

-- 2.4 delete：故意不创建任何 delete 策略 —— RLS 默认拒绝，
--     authenticated 对 huabu 中任何对象（包括自己文件夹）均无法删除。

-- 3. 验证（执行后自查）：
--    select policyname, cmd, roles from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and policyname like 'task_submissions_huabu%';
--    期望：insert_v2 / select_v2 / update_v2 三条，无 delete。
