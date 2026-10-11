# 按钮使用统计（button-usage-stats）

> openspec: `add-button-usage-stats` · 2026-10-11
>
> 目标：统计项目页面上**所有按钮**的点击次数/频率/使用人数，嵌入数据看板，
> 帮助判断哪些功能高频在用、哪些零使用。不依赖外网，数据留在自家 Supabase。

## 架构

```
浏览器（apps/web 壳层全局采集器）
  └─ 捕获阶段 click 监听：data-track > data-testid > aria-label > text:文本前20字
  └─ 批量 20 条 / 15s；pagehide/隐藏兜底；失败写 localStorage（ui_stats_pending_cache）重试
        │  POST /functions/v1/ui-stats/ingest  （用户 JWT，apikey=anon key）
        ▼
ui-stats 边缘函数（校验 + service_role 批量插入）
        ▼
Supabase 表 ui_click_events（RLS：仅 authenticated insert，不开放读）
        ▼
dashboard-stats 看板「按钮使用统计」面板
  （service_role 直查聚合：GET /functions/v1/dashboard-stats/button-usage，仅管理员）
```

- 采集器：`apps/web/src/analytics/ui-stats-capture.ts`（挂载 `UiStatsCaptureMount.tsx`，
  位于 `bootstrap.tsx` 的 AuthGate 内，即登录后的工作区）
- 入库函数：`supabase/functions/ui-stats/`
- 看板面板：`supabase/functions/dashboard-stats/`（`/button-usage` 接口 + 面板区块）

## 指标口径

| 指标 | 口径 |
| --- | --- |
| 次数 | 窗口内 `ui_click_events` 非inv行数 |
| 人数 | 同一 button_id 去重 oa_account 数 |
| 排行 | 近 7 天 / 近 30 天，按次数降序，前 15 |
| 趋势 | 近 30 天按日点击合计（东八区） |
| 零使用 | 启动清单基线（`inv:` 前缀行去重）− 窗口内被点击过的按钮 |

**零使用基线的局限**：清单来自应用就绪后首屏 DOM 的按钮（工具栏/侧栏等常驻按钮）；
对话框、抽屉内懒挂载的按钮不在基线里——零使用清单只对常驻按钮可靠。

**隐私**：只记按钮标识与页面路径，不记录任何输入内容；用户维度仅到 oa_account，
仅管理员可在看板查看。PostHog 体系保持现状不动（显式埋点仍走 PostHog）。

## 部署（一次性，手工）

```bash
# 1. 建表（Supabase 容器所在主机，属主执行）
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/ui_click_events.sql
# 验证：select count(*) from public.ui_click_events;

# 2. 部署 ui-stats 函数（沿用既有 scp 热加载方式，与 dashboard-stats 同主机）
scp -r supabase/functions/ui-stats <supabase主机>:<functions目录>/
# 冒烟（dev 网关，需有效用户 JWT）：
curl -s -X POST http://10.0.0.220:8021/functions/v1/ui-stats/ingest \
  -H "apikey: <anon-key>" -H "Authorization: Bearer <user-jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"events":[{"page":"/","buttonId":"smoke_btn"}]}'
# 期望：{"inserted":1}

# 3. dashboard-stats 函数有代码更新（新增面板），同样 scp 覆盖后生效
# 验证看板：管理员登录数据看板 → 「按钮使用统计」面板出现
```

生产（10.37.80.25 网关）同样执行 1–3（迁移 SQL 两边库都要跑）。

## 本地开发

- 采集器单测：`cd apps/web && npx vitest run src/analytics/ui-stats-capture.spec.ts`
- 函数单测：`node --test supabase/functions/ui-stats/core.test.ts`
- 本地起前端后（pnpm dev），DevTools Network 可见对 `ui-stats/ingest` 的批量 POST
  （仅当函数已部署到对应网关时返回 200；未部署时静默失败进缓存，不影响页面功能）。
