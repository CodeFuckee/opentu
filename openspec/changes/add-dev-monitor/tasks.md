# Tasks: 开发监控看板（dev-monitor 边缘函数）

## 1. 测试先行
- [x] 1.1 编写 `supabase/functions/dev-monitor/core.test.ts`：aggregatePipeline（状态计数/成功率分母/卡死阈值按类型/按模型失败/天趋势/p50-p95）、probeHealth（并行、401=存活、网关缺配置=未配置、超时=down）、verifyDevAdmin（401/403/放行）、buildDevMonitorHtml（自包含/登录/自动刷新/区块齐全）、status 编排（路由与查询形态）

## 2. 实现
- [x] 2.1 实现 `supabase/functions/dev-monitor/core.ts`：健康探测 + 管线聚合 + 失败样本 + HTML 模板（注入 fetch/env 便于单测）
- [x] 2.2 实现 `supabase/functions/dev-monitor/index.ts`：路由（GET / → HTML；GET /status → JSON；OPTIONS → CORS；其余 404/405）
- [x] 2.3 新增测试跑绿（17 条）+ 全量边缘函数套件无回归（141 条全绿）

## 3. 验证与文档
- [x] 3.1 `scripts/preview-dev-monitor.mjs` 本地 mock 预览（过目用）+ 截图自查
- [x] 3.2 `docs/dev-monitor.md`（口径、部署 scp + 冒烟、访问说明）
- [x] 3.3 `CHANGELOG.md`（Unreleased → Features / Tests）
- [x] 3.4 知识库测试台账沉淀
