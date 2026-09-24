-- ============================================================
-- 看板展示倍数 USAGE_MULTIPLIER = 6（2026-09-24 用户拍板）
--
-- 作用：dashboard-stats 看板所有使用次数与金额按 6 倍放大展示
-- （applyUsageMultiplier：次数/趋势/排行/部门汇总/金额全部参与，
--   活跃用户数/用户数分布/额度上限/汇率不受影响）。
-- 用途：对外汇报口径（成本价 → 汇报价）。
--
-- 用法（自托管 Supabase 宿主机，幂等可重复执行）：
--   cat supabase/migrations/usage_multiplier_6.sql | ssh mdc@10.37.80.25 \
--     "docker exec -i supabase-db psql -U supabase_admin -d postgres"
--
-- 回滚：把 value 改回 '1'（或 delete 该行，缺省回 1）。
-- 生效：即时（/overview 每次请求实时读 configs，无需重启/部署）。
-- ============================================================

insert into configs (key, value)
values ('USAGE_MULTIPLIER', '6')
on conflict (key) do update set value = excluded.value;
