-- ============================================================
-- ai-outputs 公开桶：AI 生成结果交付（画布/素材直链）
--
-- 用法（自托管 Supabase 宿主机）：
--   cat supabase/migrations/ai_outputs_bucket.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 背景：生成媒体归档原写 huabu（私有桶），画布 <img> 无法直链。
-- 方案 1（等待归档完成后插入、直接使用 bucket URL）要求交付桶公开读。
-- 路径为内容寻址 {username}/{date}/{sha256}.{ext}，URL 不可猜测。
-- huabu 保持私有：输入图与内部副本不受影响。
-- 幂等：可重复执行。
-- ============================================================

-- 公开读桶
insert into storage.buckets (id, name, public)
values ('ai-outputs', 'ai-outputs', true)
on conflict (id) do update set public = true;

-- 上传：仅登录用户（前端归档走用户会话）
drop policy if exists "ai_outputs_authenticated_insert" on storage.objects;
create policy "ai_outputs_authenticated_insert"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'ai-outputs');

-- upsert 说明：supabase-js 上传固定带 x-upsert:true，存储端语句为
-- INSERT .. ON CONFLICT (name, bucket_id) DO UPDATE RETURNING *：
-- 该语句要求 UPDATE 策略放行（USING/WITH CHECK），且 RETURNING 要求
-- SELECT 放行——缺任一都会以 "new row violates row-level security policy"
-- 400 拒绝（即使对象不存在、走的是纯插入路径，实测 2026-09-23）。
drop policy if exists "ai_outputs_owner_update" on storage.objects;
create policy "ai_outputs_authenticated_update"
  on storage.objects for update to authenticated
  using (bucket_id = 'ai-outputs')
  with check (bucket_id = 'ai-outputs');

drop policy if exists "ai_outputs_public_select" on storage.objects;
create policy "ai_outputs_public_select"
  on storage.objects for select to public
  using (bucket_id = 'ai-outputs');
