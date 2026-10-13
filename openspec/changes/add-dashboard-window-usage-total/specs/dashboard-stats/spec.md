# Change: 数据看板长周期（>30 天）显示区间总用量

## ADDED Requirements

### Requirement: 长周期区间总用量

overview 系统 SHALL 在 `usage` 中返回所选时间窗口覆盖的自然月用量合计
（`windowTotalUsed`，随 USAGE_MULTIPLIER 缩放）与参与合计的周期列表
（`windowMonths`）；看板页面 SHALL 仅当所选区间天数 > 30 时展示「区间总用量」
KPI 卡并标注口径（自然月合计）。

#### Scenario: 自定义 55 天区间出卡

- **WHEN** 选择 2026-08-07 ~ 2026-09-30（days=55）查询
- **THEN** usage.windowMonths 为 ['2026-08','2026-09']，windowTotalUsed 为这两个
  周期用量之和；页面出现「区间总用量」卡

#### Scenario: 短周期不出卡

- **WHEN** 选择最近一周或近 30 天
- **THEN** 页面不显示「区间总用量」卡

#### Scenario: 用量倍数口径一致

- **WHEN** configs 配置 USAGE_MULTIPLIER=N
- **THEN** windowTotalUsed 与 byPeriod/latestUsed 同倍数缩放
