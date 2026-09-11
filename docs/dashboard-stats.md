# 数据看板（dashboard-stats 边缘函数）

托管在 Supabase 后端的管理级数据看板：页面与数据聚合接口都由一个边缘函数提供，
与用户使用的前端（apps/web / 8088）完全分离，页面和数据同在
`http://10.37.80.25:8021/functions/v1/dashboard-stats/` 下。

## 功能

- `GET /functions/v1/dashboard-stats/` → 自包含 HTML 看板页面（内联 CSS/JS/SVG 图表，无外部依赖）
- `GET /functions/v1/dashboard-stats/overview?days=N` → 四类聚合统计 JSON（默认 days=30，范围 1~365）

四类指标：

| 区块 | 数据源 | 内容 |
| --- | --- | --- |
| 任务统计 | `task_submissions` | **仅统计成功（status=completed）任务**：数量、按 type 分布、按日趋势、平均耗时（页面不展示失败/状态分布与成功率） |
| 用量与额度 | `generation_usage` + `user_profiles` | 月度用量汇总、最新周期用量、Top 用户、限额 |
| 用户与组织 | `user_profiles` / `staff_directory` / `departments` / `auth.users` | 用户总数、部门/区域分布、最近注册、花名册、可用部门；用户统一显示 Display Name，取值顺序：`auth.users.user_metadata`（displayName → full_name → name，经 GoTrue admin API 按 user_id 关联）→ `staff_directory.name`（按 oa_account join）→ 回退 oa_account。注：自托管网关未放行 `/auth/v1/admin/*`，函数对网关 404 时自动降级直连内部 `http://auth:9999` |
| 文件与存储 | `file_paths`/`response_file_paths` + huabu bucket | 上传/生成文件计数、bucket 对象数与总大小 |

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

- [ ] `curl` 页面返回 200 text/html；浏览器打开渲染四类指标
- [ ] `curl` overview 返回 200 JSON，`tasks/usage/users/storage` 四区块均有数据
- [ ] 修改 `days=7/90` 后任务趋势与过滤窗口随之变化
- [ ] `node --test supabase/functions/*/core.test.ts` 全绿
