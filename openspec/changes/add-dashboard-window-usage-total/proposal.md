# Change: 数据看板长周期（>30 天）显示区间总用量

## Why

看板 KPI 的用量卡只有「本月用量」（最新周期 generation_usage），月度口径分散在
「月度用量趋势」柱状图里。当用户选了长区间（如自定义 2026-08-07 ~ 2026-09-30
或近 90 天）时，没有一个"这段时间总共用了多少"的汇总数，要自己把月柱加一遍。

## What Changes

- `overview` 响应的 `usage` 新增两个字段：
  - `windowTotalUsed`：所选时间窗口覆盖的自然月用量合计（月粒度近似，窗口只覆盖
    部分月份时按整月计入）；`usage` 本就全量聚合不分窗（byPeriod 含全部历史月），
    合计只在窗口覆盖的月集合内求和
  - `windowMonths`：参与合计的周期列表（如 `['2026-08','2026-09']`），供页面副标题
    透明展示口径
  - 字段随 `USAGE_MULTIPLIER` 一起缩放（与其他使用次数同口径），周期列表不缩放
- 页面 KPI：`days > 30` 时显示「区间总用量」卡（副标题列出覆盖周期），≤30 天不显示
- 预览脚本 fixture 补这两个字段，供本地过目

## Impact

- Affected specs: `dashboard-stats` 新增「区间总用量」requirement
- Affected code:
  - `supabase/functions/dashboard-stats/core.ts`（窗口月份计算 + 合计纯函数 +
    aggregateOverview 装配 + applyUsageMultiplier 缩放 + KPI 卡）
  - `supabase/functions/dashboard-stats/core.test.ts`（单测先行）
  - `scripts/preview-dashboard-stats.mjs`（fixture 两字段）
  - `docs/dashboard-stats.md`、`CHANGELOG.md`
- 不动 byPeriod 既有语义（仍含全部历史月，月度用量趋势面板不变）；不引入依赖；
  无数据库变更
