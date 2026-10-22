-- ============================================================
-- user_sync_data：云端同步通用实体表（画板/任务/工作流/提示词/知识库/聊天/音频/角色/素材/设置）
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_sync_data.sql
--
-- 设计要点：
--   * 一条记录一个实体，主键 (user_id, entity_type, entity_id)，行小、增量精确
--   * entity_type 枚举见注释；content 为该实体完整 JSON（媒体类实体不内嵌二进制）
--   * checksum 用于增量判断（内容变更检测），deleted_at 为软删除墓碑（tombstone）
--   * RLS：用户只能读写自己的行；匿名角色无权访问
--   * 文档见 design: openspec/changes/add-supabase-cloud-sync/design.md
-- ============================================================

-- 1. 通用同步表：一实体一行
create table if not exists public.user_sync_data (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  entity_type text        not null,                        -- 实体类型（见下方 comment）
  entity_id   text        not null,                        -- 实体主键（board.id / task.id / 'default' 等）
  content     jsonb       not null,                        -- 实体内容（不含二进制）
  checksum    text        not null default '',             -- 内容校验和（增量判断）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,                                 -- 软删除墓碑（null=未删除）
  primary key (user_id, entity_type, entity_id)
);

comment on table public.user_sync_data is '云端同步实体表（按用户隔离，一实体一行）';
comment on column public.user_sync_data.entity_type is
  '实体类型：board|folder|workspace_state|prompt|prompt_deleted(不再采集,删除走墓碑真同步)|task|workflow|workflow_graph|kb_note|kb_directory|kb_tag|kb_note_tag|kb_note_content|kb_note_image|chat_session|chat_message|audio_playlist|audio_playlist_item|character|asset|cache_media|settings|custom_tools';
comment on column public.user_sync_data.checksum is '内容校验和，用于增量同步变更检测';
comment on column public.user_sync_data.deleted_at is '软删除墓碑时间（null=存在）；其他设备据此删除本地副本';

-- 2. updated_at 自动更新触发器（复用 user_profiles.sql 定义的方法）
drop trigger if exists user_sync_data_set_updated_at on public.user_sync_data;
create trigger user_sync_data_set_updated_at
  before update on public.user_sync_data
  for each row
  execute function public.set_updated_at();

-- 3. RLS：用户只能读写自己的行
alter table public.user_sync_data enable row level security;

drop policy if exists "user_sync_data_select_own" on public.user_sync_data;
create policy "user_sync_data_select_own"
  on public.user_sync_data
  for select
  using (auth.uid() = user_id);

drop policy if exists "user_sync_data_insert_own" on public.user_sync_data;
create policy "user_sync_data_insert_own"
  on public.user_sync_data
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "user_sync_data_update_own" on public.user_sync_data;
create policy "user_sync_data_update_own"
  on public.user_sync_data
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "user_sync_data_delete_own" on public.user_sync_data;
create policy "user_sync_data_delete_own"
  on public.user_sync_data
  for delete
  using (auth.uid() = user_id);

-- 4. 授权：匿名无权访问；登录用户（authenticated）可读写自己的行（upsert = insert + update）
revoke all on public.user_sync_data from anon;
grant select, insert, update, delete on public.user_sync_data to authenticated;