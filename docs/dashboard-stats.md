# 数据看板（dashboard-stats 边缘函数）

托管在 Supabase 后端的管理级数据看板：页面与数据聚合接口都由一个边缘函数提供，
与用户使用的前端（apps/web / 8088）完全分离，页面和数据同在
`http://10.37.80.25:8021/functions/v1/dashboard-stats/` 下。

## 功能

- `GET /functions/v1/dashboard-stats/` → 自包含 HTML 看板页面（内联 CSS/JS/SVG 图表，无外部依赖）
- `GET /functions/v1/dashboard-stats/overview?days=N` → 三类聚合统计 JSON（默认 days=30，范围 1~365；
  可用 `start=YYYY-MM-DD&end=YYYY-MM-DD` 指定东八区精确区间，优先于 days，非法参数返回 400）
- `GET /functions/v1/dashboard-stats/export?days=N[&start=&end=]` → 统计数据导出 Excel（.xlsx 附件，
  参数与 overview 一致，多 sheet 与页面同口径；需管理员 JWT）

页面统计块（对照原 newapi 看板口径补全）：

| 区块 | 数据源 | 内容 |
| --- | --- | --- |
| KPI 七卡 | `task_submissions` + tu-zi 价目 | 总操作次数（成功任务）、消耗金额（USD，tu-zi 价目折算）、活跃用户数、本月用量（**全局用量，不含个人额度**）、数据覆盖天数 |
| 核心指标（领导视角） | `task_submissions` + 网关消耗日志 + `configs` | 六卡：累计调用次数（全时段成功任务）、生成图片张数（窗口内生图任务按 `params.params.n`/`params.n`/`params.count` 汇总，缺省 1 张/任务；附生图次数与全时段累计）、Token 消耗（网关日志 prompt+completion 求和，无字段显 -）、最常用模型（含模型类型数）、平均出图耗时（生图任务窗口均值）、节省委外费用估算（见下方口径）。课题汇报中的定性内容（支援项目清单、用户口碑、研发迭代/bug 数）为过程性数据，不入库不展示 |
| 操作类型分布 | `task_submissions.type` | 成功任务按 type 环图 |
| 模型使用分布 | `task_submissions.params->>model` | 成功任务按模型环图 |
| 使用次数排行 | `task_submissions.user_id` + Display Name | 用户前 10（头像=姓名首字） |
| 日历使用热力 | `created_at`（东八区） | 当月日历格热力 |
| 24小时使用分布 | `created_at`（东八区） | 0-23 时柱状 |
| 部门使用情况 / 区间使用排行 / 部门使用汇总 | 用户部门 join + tu-zi 价目 | 次数、金额、占比（排行可切部门/用户） |
| 每日成功任务趋势 | `created_at` | 折线（东八区切日） |
| 用量与额度 | `generation_usage` + `user_profiles` | 月度用量汇总、最新周期全局用量、Top 用户、限额配置 |
| 用户与组织 | `user_profiles` / `staff_directory` / `departments` / `auth.users` | 用户总数、部门/区域分布、花名册、可用部门；用户统一显示 Display Name，取值顺序：`auth.users.user_metadata`（displayName → full_name → name，经 GoTrue admin API 按 user_id 关联）→ `staff_directory.name`（按 oa_account join）→ 回退 oa_account。注：自托管网关未放行 `/auth/v1/admin/*`，函数对网关 404 时自动降级直连内部 `http://auth:9999` |

**消耗金额口径**：KPI 总额为**真实消耗**——自建 New API 网关（configs 表 NEWAPI_URL/NEWAPI_TOKEN/NEWAPI_KEY）消耗日志按 huabu 共享令牌分页求和，USD = quota ÷ 500000，含画布全部网关调用（绘图/聊天/轮询等）；网关日志无法区分到画布用户，「部门使用汇总」的金额列按 tu-zi 价目估算（`https://api.tu-zi.com/api/pricing`，按次用 model_price、按量按 1500 token/次估算）。任一数据源失败逐级降级显示 `-`。美元→人民币展示汇率可在 Supabase `configs` 表配置键 `USD_CNY_RATE`（缺省 0.1，内部结算口径 $10=¥1），改值即时生效。

**领导视角 · 节省委外费用口径**：在 `configs` 表配置键 `OUTSOURCE_PRICE_PER_IMAGE`
（单张效果图委外参考价，人民币/张，如 `80`）后启用——
`节约 = 窗口内生成图片张数 × 单价 − 窗口内实际消耗（USD × USD_CNY_RATE）`，
负值（实际消耗高于委外参考）如实展示；未配置单价时该卡显示 `-` 并提示配置键。
Token 消耗取网关消耗日志 `prompt_tokens + completion_tokens` 求和；绘图按次计费
的日志条目可能没有 token 字段，整窗均无字段时该卡显示 `-`。

**推送到钉钉**：页面右上角「推送」按钮把当前看板截图 + 周报文字经钉钉群机器人发送。图片先上传 Gitee 仓库中转（raw 直链放入 markdown），机器人用加签方式调用。依赖 `configs` 表四个键（已预置，值需填写）：`DINGTALK_WEBHOOK`（机器人 Webhook）、`DINGTALK_SECRET`（加签密钥）、`GITEE_TOKEN`（Gitee 私人令牌，需仓库写权限）、`GITEE_REPO`（中转仓库，默认 tju-kdj_admin/dingding-talk-images）。未填 webhook 时推送返回明确错误。

除特别注明外，任务类统计口径均为**仅成功（completed）任务**。

## 自定义时间范围与 Excel 导出（openspec add-dashboard-range-export）

**自定义区间**：周期下拉选「自定义区间…」，填起止日期（如 2026-08-07 ~ 2026-09-30）
后点「应用」，按东八区 `start` 当日 00:00:00 ~ `end` 当日 23:59:59 精确过滤（优先于
days 窗口）。接口直调示例：

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  "http://10.37.80.25:8021/functions/v1/dashboard-stats/overview?start=2026-08-07&end=2026-09-30&days=55"
```

非法区间（格式非 YYYY-MM-DD、非真实日历日期如 2026-02-30、只给其一、start 晚于
end）返回 400 与中文错误说明。

**区间总用量**：所选区间天数 > 30 时，KPI 区追加「区间总用量」卡——generation_usage
在窗口覆盖自然月（东八区）内的合计，月粒度近似（窗口只覆盖月内部分时该月整月计入，
副标题列出覆盖周期）；随 `USAGE_MULTIPLIER` 同倍数缩放。overview 对应字段为
`usage.windowTotalUsed` / `usage.windowMonths`。

**导出 Excel**：页面「导出Excel」按钮按当前查询区间请求 `/export`，下载
`数据看板-<统计周期>.xlsx`。零依赖手写 xlsx（stored ZIP + 最小 SpreadsheetML，
无外部包，页面/函数不引第三方库）。工作簿 12 个 sheet：概览、核心指标、操作类型
分布、模型使用分布、每日趋势、24小时分布、部门使用排行、用户使用排行、部门使用
汇总（金额 CNY=USD×汇率、占比与页面同口径）、月度用量趋势、部门分布、按钮统计
（固定近 7/30 天口径，与面板一致，不随导出区间变化；聚合失败时该 sheet 省略）。

## 实现

- `supabase/functions/dashboard-stats/index.ts`：路由入口（HTML / overview / OPTIONS）
- `supabase/functions/dashboard-stats/core.ts`：聚合逻辑 + HTML 模板（纯逻辑，注入 fetch 可单测）
- `supabase/functions/dashboard-stats/core.test.ts`：node:test 单测

聚合用 **service_role** 身份经 PostgREST / Storage REST 直查（绕过 RLS），JS 侧聚合，
无需新增数据库迁移。查询沿用 `newapi-key/core.ts` 的 REST 模式（`apikey` + `Authorization` 头）。

## 部署（自托管 Supabase，热加载生效）

```bash
ssh mdc@10.37.80.25 "mkdir -p /home/mdc/codes/supabase/volumes/functions/dashboard-stats"
scp supabase/functions/dashboard-stats/* mdc@10.37.80.25:/home/mdc/codes/supabase/volumes/functions/dashboard-stats/
```

冒烟检查：

```bash
# 页面
curl -s -o /dev/null -w "%{http_code}\n" \
  http://10.37.80.25:8021/functions/v1/dashboard-stats/
# 数据接口（携带 anon key 供 Kong 放行）
curl -s -H "Authorization: Bearer $ANON_KEY" \
  http://10.37.80.25:8021/functions/v1/dashboard-stats/overview?days=30 | head -c 300
```

环境变量（容器内已配置，函数从 `Deno.env` 读取）：

- `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_URL`（必需）
- `SUPABASE_ANON_KEY`（可选；页面 JS 调 overview 时携带的公钥，缺省用内置兜底值）

## 鉴权说明（当前：暂不做）

本函数**不校验调用者身份**——知道 URL 的人即可查看全量数据。页面 JS 携带 anon key
（公钥）仅用于通过 Kong 对 `/functions/v1/*` 的 Bearer 校验，不是访问控制。

升级路径（需要时二选一或叠加）：

1. **函数内管理员判定**：读取 `department_configs` 的 `dashboard_admins`（逗号分隔
   oa_account）或按 `staff_directory.position` 判断调用者是否为管理员，非管理员返回 403；
   调用者身份可从请求的 Supabase JWT（`sub`/`email`）解析
2. **网关/网络限制**：由 Kong 对该路径做 IP 白名单或额外鉴权

## 验收清单

- [ ] `curl` 页面返回 200 text/html；浏览器打开渲染全部统计块
- [ ] `curl` overview 返回 200 JSON（含 weekTasks/monthCostUsd/usdCnyRate 与
      `leadership` 区块），`tasks/usage/users/leadership` 区块均有数据
- [ ] 修改 `days=7/90` 后任务趋势与过滤窗口随之变化
- [ ] `node --test supabase/functions/*/core.test.ts` 全绿
- [ ] 自定义区间：页面选「自定义区间…」填起止日期点「应用」，趋势/排行随之变化；
      `overview?start=2026-02-30&end=2026-03-01` 返回 400
- [ ] 导出 Excel：`export?start=2026-08-07&end=2026-09-30` 返回 .xlsx（12 sheet），
      Excel/WPS 可打开且数值与同参数 overview 一致
- [ ] 本地纯前端过目（无需后端）：`node scripts/preview-dashboard-stats.mjs [端口]`
      打开提示的地址，登录壳已跳过，看板用 mock 数据渲染全部区块（含领导视角；
      自定义区间与导出 Excel 均可用，/export 返回真实生成的 xlsx）
