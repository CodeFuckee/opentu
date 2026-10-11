# Tasks: add-button-usage-stats

## 1. 数据库

- [ ] 1.1 `supabase/migrations/ui_click_events.sql`：建表 + RLS（authenticated insert，
      无 select）+ 索引 (button_id, created_at)、(created_at) + 头部说明块（执行方式、
      验证语句，沿用 user_roles_is_admin.sql 格式）

## 2. 边缘函数 ui-stats

- [ ] 2.1 `supabase/functions/ui-stats/index.ts`：路由（POST /ingest、OPTIONS、其余
      405/404）+ 环境变量缺失拒绝启动
- [ ] 2.2 `supabase/functions/ui-stats/core.ts`：JWT 校验（/auth/v1/user）与 oa_account
      解析（邮箱 @ 前缀）、事件字段校验（page/button_id 必填、长度上限、单批 ≤100）、
      service_role PostgREST 批量插入
- [ ] 2.3 `supabase/functions/ui-stats/core.test.ts`（node:test，注入 fake fetch）：
      未登录 401 / 字段缺失 400 / 超批量上限 400 / 合法批量写入 / service_role 异常 502

## 3. 前端采集器（apps/web）

- [ ] 3.1 采集器模块：按钮识别（data-track > data-testid > aria-label > `text:`+文本）、
      page 取 pathname、捕获阶段监听、批量队列（20 条/15s）、pagehide 兜底上报、
      失败本地缓存重试
- [ ] 3.2 启动清单上报：应用就绪后遍历 DOM 生成 `inv:` 前缀清单（去重、上限 300 条）
- [ ] 3.3 单测（vitest）：识别各层级 fallback / 批量触发阈值与定时 / pagehide flush /
      上报失败缓存恢复

## 4. 看板面板（dashboard-stats）

- [ ] 4.1 core.ts 聚合查询：Top 按钮排行（7d/30d：次数/人数/最近使用）、按日合计趋势
      （30 天）、零使用清单（inventory 基线 − clicked）
- [ ] 4.2 buildDashboardHtml 新增「按钮使用统计」区块（内联样式与现看板一致）
- [ ] 4.3 core.test.ts 补聚合纯函数用例（排行排序/趋势矩阵/零使用差集）

## 5. 文档与收尾

- [ ] 5.1 `docs/button-usage-stats.md`：迁移执行、部署（scp + 冒烟 curl）、看板口径说明
      （含 inventory 局限）
- [ ] 5.2 CHANGELOG.md（Unreleased → Added）
- [ ] 5.3 全量测试：supabase 函数 node:test + drawnix/apps vitest + 相关 E2E；
      本地全绿后交用户过目（看板面板 + 点击产生数据）
