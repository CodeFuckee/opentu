# Change: 按钮使用统计（全按钮点击采集 + 数据看板「按钮使用」面板）

## Why

产品功能多但缺使用数据，无法判断哪些功能高频在用、哪些无人使用，产品完善决策靠猜。
项目已有 PostHog 云埋点（257 处 `data-track` 标注 + tracking 服务），但全按钮自动采集
（autocapture）被关闭、覆盖不全；且生产内网能否出外网访问 PostHog 未确认，数据也存在
境外云。需要一个**不依赖外网、数据留在自家 Supabase、嵌入既有数据看板**的按钮使用统计。

## What Changes

- 新表 `ui_click_events`（`supabase/migrations/ui_click_events.sql`）：
  记录 oa_account / page / button_id / button_label / app_version / created_at；
  RLS 仅允许 authenticated insert（不开放 select，聚合走 service_role）；索引
  (button_id, created_at)、(created_at)
- 新边缘函数 `supabase/functions/ui-stats/`（自托管，scp 热加载部署，沿用 dashboard-stats 模式）：
  - `POST /functions/v1/ui-stats/ingest` → 用户 JWT 鉴权（网关 verify_jwt + 函数内
    `/auth/v1/user` 校验，oa_account 取邮箱 @ 前缀，与既有口径一致），批量写入
    （单次 ≤100 条，超限 400），返回写入数
  - `OPTIONS` → CORS 204；其余方法/路径 → 405/404
- 前端采集器（`apps/web` 壳层全局生效，覆盖整页含画布内所有按钮）：
  - document 捕获阶段 click 监听；按钮识别优先级：`data-track` > `data-testid` >
    `aria-label` > 可见文本前 20 字（`text:` 前缀）；page 取 `location.pathname`
  - 批量队列：20 条或 15 秒触发上报；pagehide 时 sendBeacon/fetch keepalive 兜底；
    失败本地缓存重试（沿用 tracking-cache 惯例）
  - 启动清单上报：应用就绪后遍历当前 DOM 全部 button/[role=button] 生成标识清单
    （button_id 加 `inv:` 前缀），支撑看板「零使用功能」对比（对话框懒挂载按钮不在
    基线，文档标注此局限）
- dashboard-stats 看板新增「按钮使用统计」面板（service_role 直查 `ui_click_events`，
  沿用既有 is_admin 门禁，非管理员不可见）：
  - Top 按钮排行表：点击次数 / 使用人数 / 最近使用时间（近 7 天与近 30 天两档）
  - 按日点击合计趋势（近 30 天条形图，纯内联 CSS，与现看板风格一致）
  - 零使用清单：inventory 基线中近 30 天零点击的按钮
- 文档 `docs/button-usage-stats.md`：迁移 SQL 执行方式、ui-stats 部署（scp + 冒烟）、
  看板访问与指标口径

## Impact

- Affected specs:
  - 新增 `button-usage-stats` capability（采集 + ingest）
  - `dashboard-stats` capability 新增「按钮使用统计」面板 requirement
- Affected code:
  - `supabase/migrations/ui_click_events.sql`（新增）
  - `supabase/functions/ui-stats/`（新增：index.ts / core.ts / core.test.ts）
  - `supabase/functions/dashboard-stats/core.ts` + `core.test.ts`（新增面板区块）
  - `apps/web/src/`（新增采集器模块 + 挂载点 + 单测）
  - `docs/button-usage-stats.md`、`CHANGELOG.md`（Unreleased → Added）
- 不动 drawnix 画布包逻辑；不引入外部依赖；PostHog 现状保持不动
- 隐私口径：只记按钮标识与页面路径，不记任何输入内容；用户维度仅到 oa_account 粒度，
  仅管理员可在看板查看
