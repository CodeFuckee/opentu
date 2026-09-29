# 开发监控看板（dev-monitor 边缘函数）

托管在 Supabase 后端的**开发运维**看板：服务健康探测 + 任务管线真实口径聚合 + 失败样本，
与面向管理/汇报的 dashboard-stats（只显示成功任务、金额按倍数缩放）口径刻意分离。
页面与数据同在 `http://10.37.80.25:8021/functions/v1/dev-monitor/` 下。

## 功能

- `GET /functions/v1/dev-monitor/` → 自包含 HTML 页面（内联 CSS/JS，无外部依赖）；
  匿名可取的登录壳（oa账号+密码，与主应用同规则），数据接口才要求管理员 JWT
- `GET /functions/v1/dev-monitor/status?days=N` → 聚合 JSON（默认 days=7，范围 1~90）

页面区块：

| 区块 | 内容 |
| --- | --- |
| 服务健康 | 每次刷新实时并行探测六项：PostgREST（service_role 查询）、GoTrue（/auth/v1/health，404 回退 /auth/v1/settings）、Storage（/storage/v1/status）、ai-proxy 函数（无 JWT 调 /quota，401=存活）、New API 网关（/api/status）、网关管理令牌（/api/token/，configs 缺 NEWAPI_URL/NEWAPI_TOKEN 时显示「未探测」）。单探测 5s 超时，互不阻塞 |
| 任务管线 | 成功率、成功/失败/取消/卡死计数、出图耗时 p50/p95（按类型拆） |
| 按模型失败排行 | failed/total（失败率条形，取前 10） |
| 按天归档趋势 | 每日归档任务数与失败数（东八区切日，近 14 天） |
| 失败样本 | 最近 50 条 failed 任务：时间、用户 OA、类型、模型、耗时、error 摘要 |
| 卡死任务 | submitted 超过类型阈值：按等待时长倒序，最多 20 条 |
| 结果完整性 | 窗口内 completed 的 image/video/audio 任务结果核验：应产出文件任务数、结果未归档（response_file_paths 为空）、不在 bucket（按 {用户名}/{日期}/ 前缀并行列出 huabu 对象核验，路径找不到）、零字节（对象存在但 size=0）、未核验（前缀超 400 上限不计入异常）；附异常样本（前 10 条：问题/路径/用户/大小） |
| 爬虫入库 | 四张爬虫表各一张卡片：窗口内新增条数（跟随统计窗口，默认近 7 日）、全库总条数、最近入库时间（相对时间，悬浮显完整时间）——最近入库停在几天前即可发现爬虫断供。口径：ai_templates 按 `crawled_at`、jzxz_materials / jzxz_home_materials / jzxz_plant_materials 按 `created_at`（时间列仅首次插入写入，upsert 不覆盖，窗口内新增 = 新爬取入库）。计数走 `Prefer: count=exact` + Content-Range 尾段；最近入库走 `order=<ts>.desc.nullslast&limit=1`。每库两条查询并行、字段级降级（单表失败仅该卡片显示「-」） |
| 存储桶占用 | 各 bucket 的对象数、占用字节（metadata->>size 合计）、公开/私有、相对占比条与合计行；**全量口径，不随统计窗口变化**。数据经 PostgREST storage schema（`Accept-Profile: storage`）全量分页读 `storage.objects`，bucket 清单（/storage/v1/bucket）补公开标志与空桶（清单失败降级显示 '-'）。需要 PGRST_DB_SCHEMAS 含 storage（官方 docker 默认已含），未暴露或查询失败时该区块显示「拉取失败」，不拖垮其余板块 |

页面默认**每 30 秒自动刷新**（可开关）；窗口天数切换：今日 / 7 / 14 / 30 天。

## 口径（与用户看板的差异，重要）

- **成功率 = completed / (completed + failed + cancelled)**：cancelled 单列展示、
  不算失败；卡死（submitted 超时未终态）不计入分母
- **平台错误率 = 平台错误失败 / (completed + cancelled + 平台错误失败)**：
  失败按 error 内容分类——余额不足、上游失败视为外部原因，整体排除在分子分母之外
  （上游大面积故障不会污染本指标）；其余失败（含 edge 被杀、未知原因）计入平台错误。
  分类靠关键词匹配（整 error 对象文本，含 apiErrorBody 原始报文 + httpStatus 502/503/504）：
  - 余额不足：`insufficient_user_quota`、`insufficient quota`、`余额不足`、`额度不足`、
    `额度已用尽`、`预扣费额度失败`、`令牌额度已用尽`、`quota is not enough`
  - 上游失败：`upstream_error`、`upstream error`、`upstream timeout`、`上游错误`、
    `上游失败`、`上游超时`、`上游服务`、`bad gateway`、`service unavailable`、
    `gateway timeout` + httpStatus ∈ {502,503,504}
  - 关键词清单在 `core.ts` 的 `BALANCE_KEYWORDS` / `UPSTREAM_KEYWORDS`，随实际报文沉淀可增补
- **卡死阈值按类型**：image 10 分钟、video 30 分钟、其余 10 分钟
- **结果完整性核验**：只统计 completed 的 image/video/audio（chat 纯文本不参与）；
  按记录的 response_file_paths 推导 `{用户名}/{日期}/` 前缀，经 Storage list API
  并行分页核验（前缀上限 400，超限任务计入「未核验」不计异常；storage list 返回的
  对象名同时按完整路径与前缀相对名建索引，兼容两种返回格式）
- **不缩放**：不走 USAGE_MULTIPLIER（开发要真实数字）
- **失败明细可见**：`task_submissions.error` 的摘要（message 优先，JSON 截断 200 字符）
  只出现在本页，永不上 dashboard-stats

## 实现

- `supabase/functions/dev-monitor/index.ts`：路由入口（HTML / status / OPTIONS）
- `supabase/functions/dev-monitor/core.ts`：探测 + 聚合 + HTML 模板（纯逻辑，注入 fetch 可单测）
- `supabase/functions/dev-monitor/core.test.ts`：node:test 单测（与 dashboard-stats 模式一致）
- 聚合用 **service_role** 经 PostgREST 直查（绕过 RLS），JS 侧聚合，无新增数据库迁移；
  函数自包含目录（不跨函数 import），scp 单目录即可部署
- 存储桶占用分页健壮性：`order=id.asc` 稳定排序 + offset 按实收行数推进 + 空页才结束，
  即使 PostgREST 按 `db-max-rows` 截断响应也不漏页；`metadata->>size`（->> 返回文本）
  经 Number() 归一
- 爬虫入库计数与 db-max-rows 无关（Content-Range 尾段为过滤集精确总数，不随返回行数截断）；
  最近入库单行查询不受行数上限影响
- 60s 边缘函数超时约束：探测并行 + 单探测 5s 超时；窗口行 limit 20000、失败样本 50 条；
  爬虫入库每库 2 条 limit=1 轻查询、四库并行

## 部署（自托管 Supabase，热加载生效）

```bash
ssh mdc@10.37.80.25 "mkdir -p /home/mdc/codes/supabase/volumes/functions/dev-monitor"
scp supabase/functions/dev-monitor/* mdc@10.37.80.25:/home/mdc/codes/supabase/volumes/functions/dev-monitor/
```

冒烟检查：

```bash
# 页面（匿名登录壳）
curl -s -o /dev/null -w "%{http_code}\n" http://10.37.80.25:8021/functions/v1/dev-monitor/
# 数据接口（未带 JWT → 401 即为门禁生效）
curl -s http://10.37.80.25:8021/functions/v1/dev-monitor/status
# 携带管理员 access_token 调用
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://10.37.80.25:8021/functions/v1/dev-monitor/status?days=7" | head -c 300
```

环境变量（容器内已配置，函数从 `Deno.env` 读取）：

- `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_URL` / `SUPABASE_ANON_KEY`（必需，缺一拒绝启动；
  兼容 `ANON_KEY` 注入名）
- 网关探测项依赖 `configs` 表 `NEWAPI_URL` / `NEWAPI_TOKEN`（缺失时该项显示「未探测」，
  不影响其余探测）

## 鉴权

页面是匿名可取的登录壳；`/status` 要求「有效用户 JWT + 数据库统一 RPC is_admin()=true」
（未登录/无效 401、非管理员/RPC 异常 403 fail-closed）。页面 JS 只携带 anon key 与
登录会话 token，service_role 仅在函数内使用，绝不进页面。

## 验收清单

- [ ] `curl` 页面返回 200 text/html；浏览器打开渲染全部区块
- [ ] 未带 JWT 调 `/status` 返回 401；非管理员 403
- [ ] 管理员登录后健康探测六卡出数据；拔掉网关配置时对应卡显示「未探测」
- [ ] 爬虫入库四卡出数据（模板/贴图素材/家居模型/植物模型），切窗口天数标题与新增口径跟随；
      某爬虫表查询失败时仅对应卡片显示「-」，其余卡片正常
- [ ] `node --test supabase/functions/*/core.test.ts` 全绿
- [ ] 本地纯前端过目（无需后端）：`node scripts/preview-dev-monitor.mjs [端口]`
      打开提示的地址，登录壳已跳过，页面用 mock 数据渲染全部区块
