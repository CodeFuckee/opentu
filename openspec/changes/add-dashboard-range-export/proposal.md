# Change: 数据看板自定义时间范围 + 统计数据导出 Excel

## Why

看板目前只能选「最近一周 / 近 30 / 90 天 / 2026-08、2026-09 自然月快选」，无法查任意
区间（如 2026-08-07 ~ 2026-09-30）；统计数据也只有整页 PNG 截图与文本周报两种出口，
汇报时经常需要把数字贴进表格，人工搬运易错。后端 `/overview` 代码里其实已支持
`start`/`end` 精确区间参数（add-dashboard-stats 后续迭代加入，规格未记录），缺的是
页面入口与导出能力。

## What Changes

- **自定义时间范围入口**（看板页面，`buildDashboardHtml`）：
  - 周期下拉新增「自定义区间…」选项，选中后显示起/止两个 `<input type="date">`
    与「应用」按钮（type=date 非安全上下文专属 API，HTTP 内网可用，符合部署红线）
  - 「应用」校验：起止必填、start ≤ end，非法则提示不请求；通过后按东八区口径拼
    `overview?start=&end=&days=区间天数` 走既有加载流程，标题栏显示区间标签
  - 后端 `/overview` 的 start/end 校验加固：格式非 YYYY-MM-DD、非真实日历日期、
    或 start > end 时返回 400（原先静默回退 days 窗口，易掩盖调用方 bug）
- **统计数据导出 Excel**（新端点 `GET /functions/v1/dashboard-stats/export`）：
  - 仅管理员（与 overview 同 `verifyDashboardAdmin` 门禁；未登录 401、非管理员 403）
  - 参数与 overview 完全一致（`days=N` 或 `start=&end=`），返回 .xlsx 附件
  - 零依赖手写 xlsx 生成器（stored ZIP + 最小 SpreadsheetML，纯函数可单测）——
    看板是零外部脚本的自包含 HTML（有测试守护），不能引入 npm xlsx 包
  - 全量多 sheet：概览 / 核心指标 / 操作类型分布 / 模型使用分布 / 每日趋势 /
    24小时分布 / 部门使用排行 / 用户使用排行 / 部门使用汇总 / 月度用量趋势 /
    部门分布 / 按钮统计（固定近7/30天口径，注明）；部门汇总金额、占比与页面渲染同口径
  - 页面新增「导出Excel」按钮：复用当前查询区间，带 JWT 请求后以 blob 下载
    （文件名含统计周期），401 时先刷新会话重试一次
- 「按钮使用统计」面板保持固定近7/30天口径，不随区间变化（用户拍板）
- 预览脚本 `scripts/preview-dashboard-stats.mjs` 补 mock：/export 返回真实生成的
  xlsx（用同一 mock fixture）、/button-usage 返回 mock 摘要

## Impact

- Affected specs: `dashboard-stats`（新增「自定义时间范围」「统计数据导出 Excel」
  两个 requirement；补记 overview 已存在的 start/end 区间能力）
- Affected code:
  - `supabase/functions/dashboard-stats/core.ts`（xlsx 写入器 + 工作簿组装 +
    `parseOverviewRange` + 看板页面自定义区间 UI 与导出按钮）
  - `supabase/functions/dashboard-stats/index.ts`（/export 路由 + overview 参数校验）
  - `supabase/functions/dashboard-stats/core.test.ts`（新增单测，先行）
  - `scripts/preview-dashboard-stats.mjs`（mock /export 与 /button-usage）
  - `docs/dashboard-stats.md`、`CHANGELOG.md`
- 不动 drawnix 画布包与主应用；不引入任何外部依赖；不涉及数据库迁移
- Excel 生成纯内存完成（聚合行数上限 50000，单 sheet 上限受聚合口径约束，
  体量 MB 级以内，自托管 edge-runtime 无响应体限制问题）
