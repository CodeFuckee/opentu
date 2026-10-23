-- ============================================================
-- user_sync_data 服务端统一时钟：updated_at 由触发器生成（毫秒精度）
--
-- 用途（openspec/changes/remove-local-persistence D3）：
--   乐观锁 CAS 依赖「updated_at 由服务端生成且可无损往返到 JS epoch ms」。
--   旧触发器（before update, set_updated_at = now()）为微秒精度，
--   JS Date.parse 会截断微秒 → 条件更新 .eq('updated_at', base) 永不命中。
--   本触发器改为 insert or update 都生效并截断到毫秒。
--
-- 用法（自托管 Supabase）：
--   docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_sync_data_server_clock.sql
--
-- 兼容性：旧客户端写入时自带的 updated_at 将被服务端值覆盖（旧 reconcile 的
-- LWW 本就以 updatedAt 比较，服务端时钟单调更可靠）；无需数据回填。
-- ============================================================

create or replace function public.set_updated_at_ms()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := date_trunc('milliseconds', now());
  return new;
end;
$$;

drop trigger if exists user_sync_data_set_updated_at on public.user_sync_data;
create trigger user_sync_data_set_updated_at
  before insert or update on public.user_sync_data
  for each row
  execute function public.set_updated_at_ms();
