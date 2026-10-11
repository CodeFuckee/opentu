# Change: dashboard-stats 看板新增「按钮使用统计」面板

## ADDED Requirements

### Requirement: 按钮使用统计面板

数据看板 SHALL 新增「按钮使用统计」区块，由 service_role 直查 `ui_click_events` 聚合
渲染：Top 按钮排行（近 7 天与近 30 天：点击次数/使用人数/最近使用）、近 30 天按日点击
合计趋势、零使用清单（inventory 基线减去近 30 天有点击按钮）。面板沿用看板既有
is_admin 门禁。

#### Scenario: 管理员查看按钮排行

- **WHEN** 管理员打开数据看板
- **THEN** 「按钮使用统计」区块展示近 7 天与近 30 天的按钮点击排行（含使用人数与最近
  使用时间），按点击次数降序

#### Scenario: 查看趋势与零使用

- **WHEN** 管理员打开数据看板
- **THEN** 区块展示近 30 天按日点击合计趋势，以及 inventory 基线中近 30 天零点击的
  按钮清单

#### Scenario: 非管理员不可见数据

- **WHEN** 非管理员用户调用看板聚合接口
- **THEN** 返回 403（沿用既有 is_admin 门禁行为）
