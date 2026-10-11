# Change: 按钮使用统计（采集与入库）

## ADDED Requirements

### Requirement: 全按钮点击采集

系统 SHALL 在应用壳层以捕获阶段监听整页按钮点击（含画布内按钮），自动识别被点按钮，
无需逐个手工埋点。

#### Scenario: 点击已显式标注的按钮

- **WHEN** 用户点击带 `data-track` 属性的按钮
- **THEN** 采集事件 button_id 取该属性值

#### Scenario: 点击未标注的按钮

- **WHEN** 用户点击无 `data-track` 的按钮
- **THEN** button_id 依次回退取 `data-testid`、`aria-label`，均缺失时取
  `text:` 前缀 + 可见文本前 20 字
- **AND** 事件包含 page（location.pathname）与用户标识

#### Scenario: 批量与兜底上报

- **WHEN** 队列满 20 条或距上次上报超过 15 秒
- **THEN** 批量 POST 到 `ui-stats` ingest
- **AND** 页面隐藏（pagehide）时立即上报未发送事件；上报失败的事件本地缓存并随后续
  批次重试

### Requirement: 点击事件入库

系统 SHALL 提供边缘函数 `POST /functions/v1/ui-stats/ingest`，将按钮点击事件批量写入
Supabase 表 `ui_click_events`。

#### Scenario: 合法批量写入

- **WHEN** 携带有效用户 JWT POST 不超过 100 条格式合法的事件
- **THEN** 返回 200 与写入条数，事件以该用户 oa_account（邮箱 @ 前缀）落库

#### Scenario: 未登录拒绝

- **WHEN** 不携带或携带无效 JWT 调用 ingest
- **THEN** 返回 401，不写入任何事件

#### Scenario: 超批量上限拒绝

- **WHEN** 单次提交超过 100 条
- **THEN** 返回 400，不写入任何事件

### Requirement: 启动按钮清单上报

系统 SHALL 在应用就绪后采集当前 DOM 中全部 button/[role=button] 的标识清单（`inv:`
前缀）上报入库，作为「零使用功能」对比基线。

#### Scenario: 就绪后上报清单

- **WHEN** 应用完成启动渲染
- **THEN** 上报一条 `inv:` 前缀清单事件（去重、上限 300 个标识）

#### Scenario: 零使用计算基线

- **WHEN** 看板计算零使用清单
- **THEN** 以 inventory 基线减去近 30 天有点击的按钮得到差集
