-- ============================================================
-- ui_click_events：按钮使用统计事件表（2026-10-11，openspec add-button-usage-stats）
--
-- 目标：全按钮点击采集的数据底座——web 壳层采集器批量上报到 ui-stats 边缘函数，
--   函数以 service_role 写入本表；dashboard-stats 看板以 service_role 直查聚合，
--   渲染「按钮使用统计」面板（排行/趋势/零使用清单）。
--
-- 字段口径：
--   oa_account   用户标识（邮箱 @ 前缀，与全站口径一致）；'inv:' 清单事件记上报者
--   page         点击发生页面（location.pathname）
--   button_id    按钮标识：data-track > data-testid > aria-label > 'text:'+可见文本前20字；
--                启动按钮清单事件加 'inv:' 前缀（每标识一条）
--   button_label 人类可读名（aria-label 或文本，便于看板直读）
--   app_version  前端版本（version.json），用于区分版本间的按钮变化
--
-- RLS：启用；仅 authenticated 可 insert（兜底直连 PostgREST 写入的路径），
--   不开放 select/update/delete——看板聚合走 service_role 绕过 RLS。
--
-- 用法（自托管 Supabase，以表属主 supabase_admin 执行）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/ui_click_events.sql
--
-- 验证：
--   select count(*) from public.ui_click_events;
--   select button_id, count(*) c, count(distinct oa_account) users
--     from public.ui_click_events
--    where created_at > now() - interval '7 days'
--    group by button_id order by c desc limit 10;
-- ============================================================

create table if not exists public.ui_click_events (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  oa_account   text not null default 'anonymous',
  page         text not null,
  button_id    text not null,
  button_label text,
  app_version  text,
  constraint ui_click_events_page_len check (char_length(page) <= 200),
  constraint ui_click_events_button_id_len check (char_length(button_id) <= 200),
  constraint ui_click_events_button_label_len check (char_length(button_label) <= 200)
);

create index if not exists ui_click_events_button_created_idx
  on public.ui_click_events (button_id, created_at desc);
create index if not exists ui_click_events_created_idx
  on public.ui_click_events (created_at desc);

alter table public.ui_click_events enable row level security;

drop policy if exists "authenticated can insert ui click events" on public.ui_click_events;
create policy "authenticated can insert ui click events"
  on public.ui_click_events
  for insert
  to authenticated
  with check (true);
