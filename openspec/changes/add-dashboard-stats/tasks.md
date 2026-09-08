# Tasks: Supabase 后端数据看板（dashboard-stats 边缘函数）

## 1. 实现
- [ ] 1.1 实现 `supabase/functions/dashboard-stats/core.ts`：service_role PostgREST 查询 + 四类聚合 + HTML 页面模板（注入 fetch/env 便于单测）
- [ ] 1.2 实现 `supabase/functions/dashboard-stats/index.ts`：路由（GET / → HTML；GET /overview → JSON；OPTIONS → CORS；其余 404/405）
- [ ] 1.3 编写 `supabase/functions/dashboard-stats/core.test.ts`（mock fetch，node --test，与 ai-proxy/newapi-key 模式一致）

## 2. 验证
- [ ] 2.1 本地运行 `node --test supabase/functions/*/core.test.ts` 全绿
- [ ] 2.2 更新 `docs/dashboard-stats.md`（部署 scp + 冒烟 + 访问说明）
- [ ] 2.3 更新 `CHANGELOG.md`（Unreleased → Added）

## 3. 部署（生产改动，执行前再确认）
- [ ] 3.1 scp 函数目录到 `mdc@10.37.80.25:/home/mdc/codes/supabase/volumes/functions/dashboard-stats/`（热加载）
- [ ] 3.2 冒烟：`curl` 看板页面与 `/overview` 返回 200；浏览器打开确认效果

## 4. 交付
- [ ] 4.1 建 `feature/dashboard-stats` 分支、提交、推送、提 MR（merge 由用户安排）
