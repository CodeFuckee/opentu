# Tasks: add-template-gallery

## 1. Phase 0 — 接口侦察（阻塞后续项）

- [x] 1.1 浏览器 DevTools 打开建筑学长 AI 模板广场，抓包定位列表接口
      （URL/参数/响应结构/是否需要登录态），记录到 design.md 附录
- [x] 1.2 抓包定位模板详情接口（完整 prompt / 工作流步骤 / 标签）
- [x] 1.3 确认分类→接口参数映射（11 个分类的请求参数取值）
- [x] 1.4 ~~若接口需登录态~~ 实测列表/详情均游客可访问，无需登录态

## 2. 数据层

- [x] 2.1 编写 `supabase/migrations/ai_templates.sql`（表 + RLS + `use_template` RPC，
      幂等可重跑）并在服务器执行
- [x] 2.2 确认 `huabu` bucket 的 `templates/` 前缀上传权限（service_role 可写）

## 3. 爬虫边缘函数

- [x] 3.1 `supabase/functions/template-crawler/core.ts`：列表/详情 API 客户端、
      字段映射、content_hash 增量对比、控速 sleep、封面转存、upsert 组装
- [x] 3.2 管理员鉴权（JWT 自证 + `dashboard_admins` 白名单）与 `/crawl`、`/stats` 端点
- [x] 3.3 `core.test.ts` 单测（fixture 驱动：映射、增量判定、被杀/CPU 限路径、鉴权分支）
- [x] 3.4 部署服务器 + 小批量实测爬取，人工核对入库数据与转存封面（封面改存公开桶 images）
- [ ] 3.5 首次全量爬取 + `scripts/crawl-templates.mjs` 触发脚本

## 4. 前端模板中心

- [x] 4.1 `components/template-gallery/`：容器（分类 tab/排序/搜索）+ 瀑布流卡片 +
      详情弹层（复制提示词、「去创作」、「导入工作流」）
- [x] 4.2 `ai-input-bar` 模板入口按钮 + 「去创作」填充链路 + `use_template` RPC 调用
- [ ] 4.3 工作流类模板走 `workflow-converter` 导入链路
- [ ] 4.4 前端 vitest 用例（渲染、筛选、使用计数调用、填充链路）

## 5. 收尾

- [x] 5.1 全量本地测试（前端 vitest + 边缘函数 node:test）通过
- [x] 5.2 CHANGELOG + docs（模板中心用法）更新
- [ ] 5.3 用户过目前端效果后推送，监控 CI 到终态
