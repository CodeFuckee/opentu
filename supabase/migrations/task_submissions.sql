-- ============================================================
-- task_submissions：AI 生成任务参数归档
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/task_submissions.sql
--
-- 设计要点：
--   * 任务创建时归档参数（status=submitted），完成/失败/取消时回写同一行
--   * 文件字段（base64 参考图等）上传到 bucket `huabu`，参数中以存储路径替换
--   * 用户名（oa账号）作为 bucket 目录，路径 {用户名}/{YYYY-MM-DD}/input-{sha256}.{ext}
--   * RLS：用户只能读写自己的行；storage 策略仅允许用户操作自己用户名目录下的对象
--   * 文档见 docs/task-submission-archive.md
-- ============================================================

-- 1. 归档表：每任务一行（task_id 为前端任务队列 id）
create table if not exists public.task_submissions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  task_id      text        not null,                        -- 前端任务队列 task.id
  type         text        not null,                        -- image/video/audio/chat/...
  params       jsonb       not null,                        -- 文件字段已替换为存储路径的完整参数
  file_paths   jsonb       not null default '[]'::jsonb,    -- 本次归档上传的文件路径列表
  status       text        not null default 'submitted',    -- submitted|completed|failed|cancelled
  result       jsonb,                                       -- 完成时补充
  error        jsonb,                                       -- 失败时补充
  created_at   timestamptz not null default now(),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  unique (user_id, task_id)                                 -- 配合前端 upsert onConflict
);

comment on table public.task_submissions is 'AI 生成任务参数归档（含上传到 huabu bucket 的文件路径）';
comment on column public.task_submissions.file_paths is '本次归档上传到 huabu bucket 的文件路径列表';
comment on column public.task_submissions.status is 'submitted=创建时归档 / completed|failed|cancelled=终态回写';

-- 2. updated_at 自动更新触发器（复用 user_profiles.sql 定义的方法）
drop trigger if exists task_submissions_set_updated_at on public.task_submissions;
create trigger task_submissions_set_updated_at
  before update on public.task_submissions
  for each row
  execute function public.set_updated_at();

-- 3. RLS：用户只能读/写自己的行
alter table public.task_submissions enable row level security;

drop policy if exists "task_submissions_select_own" on public.task_submissions;
create policy "task_submissions_select_own"
  on public.task_submissions
  for select
  using (auth.uid() = user_id);

drop policy if exists "task_submissions_insert_own" on public.task_submissions;
create policy "task_submissions_insert_own"
  on public.task_submissions
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "task_submissions_update_own" on public.task_submissions;
create policy "task_submissions_update_own"
  on public.task_submissions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "task_submissions_delete_own" on public.task_submissions;
create policy "task_submissions_delete_own"
  on public.task_submissions
  for delete
  using (auth.uid() = user_id);

-- 4. 授权给 authenticated（写入为 upsert：insert + update；归档表数据敏感，不开放给 anon）
revoke all on public.task_submissions from anon;
grant select, insert, update, delete on public.task_submissions to authenticated;

-- ============================================================
-- 5. Storage bucket `huabu`：任务输入文件
-- ============================================================

-- 5.1 创建 bucket（私有，不公开）
insert into storage.buckets (id, name, public)
values ('huabu', 'huabu', false)
on conflict (id) do nothing;

-- 5.2 Storage 对象级策略：文件名首段 == 登录邮箱 @ 前缀（oa账号），
--     即 {用户名}/{YYYY-MM-DD}/input-*.ext 中的用户名字段
--     清洗规则与前端 sanitizeUsername 一致：小写 + [^a-z0-9._-] 替换为 _
drop policy if exists "task_submissions_huabu_insert" on storage.objects;
create policy "task_submissions_huabu_insert"
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "task_submissions_huabu_select" on storage.objects;
create policy "task_submissions_huabu_select"
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "task_submissions_huabu_update" on storage.objects;
create policy "task_submissions_huabu_update"
  on storage.objects
  for update to authenticated
  using (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  )
  with check (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );

drop policy if exists "task_submissions_huabu_delete" on storage.objects;
create policy "task_submissions_huabu_delete"
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'huabu'
    and (storage.foldername(name))[1] =
        lower(regexp_replace(split_part(auth.jwt() ->> 'email', '@', 1), '[^a-z0-9._-]', '_', 'g'))
  );