# Change: 开发监控看板（dev-monitor 边缘函数）

## Why

dashboard-stats 面向管理/汇报口径（只显示成功任务、金额按倍数缩放、不展示失败细节），
开发者排查"程序现在正不正常、刚才为什么坏"需要的是另一套口径：真实成功率、失败明细、
卡死任务、各依赖服务健康状态。这些数据已沉淀在 `task_submissions`（含 `status` 状态机
与 `error` jsonb）与各服务端点上，只缺一个面向开发的聚合视图。

## What Changes

- 新增边缘函数 `supabase/functions/dev-monitor/`（自托管 Supabase，scp 热加载部署，
  自包含目录不跨函数引用）：
  - `GET /functions/v1/dev-monitor/` → 自包含 HTML 开发看板（内联 CSS/JS，无外部依赖；
    匿名可取的登录壳，30 秒自动刷新可开关）
  - `GET /functions/v1/dev-monitor/status?days=N` → 聚合 JSON（默认 days=7，1~90）
  - `OPTIONS` → CORS 204；其余方法/路径 → 404/405
- 健康探测（每次刷新实时并行，单探测 5s 超时，互不阻塞）：
  PostgREST（service_role 查询）、GoTrue（/auth/v1/health，404 时回退 /auth/v1/settings）、
  Storage（/storage/v1/status）、ai-proxy 边缘函数（无 JWT 调 quota，401=存活）、
  New API 网关（/api/status）、网关管理令牌（configs 有 NEWAPI_TOKEN 才探测，缺配置显示"未配置"）
- 任务管线聚合（`task_submissions`，service_role 绕过 RLS，JS 侧聚合）：
  - 状态计数：completed/failed/cancelled/卡死（submitted 且 created_at 早于类型阈值：
    image 10 分钟、video 30 分钟、其余 10 分钟）
  - 成功率 = completed / (completed+failed+cancelled)，分母为 0 时 null
  - 按模型失败排行（failed/total）、按天 total/failed 趋势
  - 出图耗时 p50/p95（completed 且双时间戳，按 type 拆）
- 失败样本：最近 50 条 failed 任务（时间、用户 OA 账号、类型、模型、耗时、error 摘要）；
  卡死列表：卡死任务按等待时长倒序（时间、OA、类型、模型、已等待）
- 鉴权：与 dashboard-stats 相同的门禁——页面匿名可取（登录壳），
  `/status` 要求「有效用户 JWT + is_admin()=true」（未登录 401、非管理员 403 fail-closed）；
  页面 JS 只携带 anon key 与登录会话 token，service_role 仅在函数内使用
- 文档 `docs/dev-monitor.md`：口径、部署（scp + 冒烟）与访问说明

## Impact

- Affected specs:
  - 无现有 spec 覆盖此能力（新增 `dev-monitor` capability）
- Affected code:
  - `supabase/functions/dev-monitor/`（新增：index.ts / core.ts / core.test.ts）
  - `scripts/preview-dev-monitor.mjs`（新增：本地 mock 预览，过目用）
  - `docs/dev-monitor.md`（新增）
  - `CHANGELOG.md`（Unreleased → Features）
- 无需新增数据库迁移、不动 apps/web 与用户前端、不引入外部依赖；
  不改 dashboard-stats（两套口径分离）
