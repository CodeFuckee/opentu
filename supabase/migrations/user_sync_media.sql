-- ============================================================
-- user_sync_media：云端同步媒体元数据表 + Storage bucket `yue-sync`
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_sync_media.sql
--
-- 设计要点：
--   * 二进制文件存 Storage 私有桶 `yue-sync`，本表只存元数据，主键 (user_id, url)
--   * url 为本地缓存/素材虚拟路径（/asset-library/*、/__aitu_cache__/*）或远程原始 URL
--   * storage_path 形如 {sanitized-username}/{category}/{sha256}.{ext}，按内容哈希天然去重
--   * RLS：用户只能读写自己的行；storage 策略按 storage.foldername(name)[1] 与
--     登录邮箱 @ 前缀（sanitizeUsername 规则）匹配，与 task_submissions_huabu_* 一致
--   * 文档见 design: openspec/changes/add-supabase-cloud-sync/design.md
-- ============================================================

-- 1. 媒体元数据表：一 URL 一行
create table if not exists public.user_sync_media (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  url          text        not null,                        -- 本地虚拟路径或远程 URL（主键）
  type         text        not null,                        -- image|video|audio
  mime_type    text,                                        -- MIME 类型
  size         bigint,                                      -- 字节
  storage_path text        not null,                        -- {用户名}/{分类}/{sha256}.{ext}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, url)
);

comment on table public.user_sync_media is '云端同步媒体元数据（二进制存 yue-sync bucket）';
comment on column public.user_sync_media.storage_path is 'Storage 对象路径 {用户名}/{分类}/{sha256}.{ext}';

-- 2. updated_at 自动更新触发器（复用 user_profiles.sql 定义的方法）
drop trigger if exists user_sync_media_set_updated_at on public.user_sync_media;
create trigger user_sync_media_set_updated_at
  before update on public.user_sync_media
  for each row
  execute function public.set_updated_at();

-- 3. RLS：用户只能读写自己的行
alter table public.user_sync_media enable row level security;

drop policy if exists "user_sync_media_select_own" on public.user_sync_media;
create policy "user_sync_media_select_own"
  on public.user_sync_media
  for select
  using (auth.uid() = user_id);

drop policy if exists "user_sync_media_insert_own" on public.user_sync_media;
create policy "user_sync_media_insert_own"
  on public.user_sync_media
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_sync_media_update_own" on public.user_sync_media;
create policy "user_sync_media_update_own"
  on public.user_sync_media
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_sync_media_delete_own" on public.user_sync_media;
create policy "user_sync_media_delete_own"
  on public.user_sync_media
  for delete
  using (auth.uid() = user_id);

-- 4. 授权：匿名无权访问；登录用户可读写自己的行
revoke all on public.user_sync_media from anon;
grant select, insert, update, delete on public.user_sync_media to authenticated;

-- ============================================================
-- 5. Storage bucket `yue-sync`：云同步媒体二进制（私有，不公开）
-- ============================================================

-- 5.1 创建 bucket
insert into storage.buckets (id, name, public)
values ('yue-sync', 'yue-sync', false)
on conflict (id) do nothing;

-- 5.2 Storage 对象级策略：文件名首段 == 登录邮箱 @ 前缀（sanitizeUsername 规则），
--     即 {用户名}/{category}/{sha256}.{ext} 中的用户名字段
--     清洗规则与前端 sanitizeUsername 一致：小写 + [^a-z0-9._-] 替换为 _
drop policy if exists "user_sync_media_yue_sync_insert" on storage.objects;
create policy "user_sync_media_yue_sync_insert"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'yue-sync'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "user_sync_media_yue_sync_select" on storage.objects;
create policy "user_sync_media_yue_sync_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'yue-sync'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "user_sync_media_yue_sync_update" on storage.objects;
create policy "user_sync_media_yue_sync_update"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'yue-sync'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  )
  with check (
    bucket_id = 'yue-sync'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "user_sync_media_yue_sync_delete" on storage.objects;
create policy "user_sync_media_yue_sync_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'yue-sync'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );