# task-monitor 边缘函数：生图 60s 被杀监控

监控 `task_submissions` 表中的生图任务，回答一个问题：**「超过 60 秒的生图任务
现在是否还会被 edge-runtime 杀死？」**（对应 2026-09-15 的
`workerTimeoutMs 60s→15min` 修复，见 `docs/ai-proxy-edge-function.md`「超时配置」）

## 用法

```bash
# 带任意有效 Supabase 用户 JWT
curl "http://10.37.80.25:8021/functions/v1/task-monitor?hours=24" \
  -H "Authorization: Bearer <JWT>"

# 或 POST
curl -X POST "http://10.37.80.25:8021/functions/v1/task-monitor" \
  -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" \
  -d '{"hours": 72}'
```

- `hours`：统计窗口，缺省 24，上限 168；GET query 或 POST body 均可
- 鉴权（2026-09-16 起管理员限定）：任意有效 Supabase 用户 JWT（函数内经
  `/auth/v1/user` 自证，未登录返回 401）+ 数据库统一 RPC `is_admin()`
  （非管理员返回 403）。管理员判定单点在 DB：
  `user_profiles.role='admin'` 优先，configs 历史名单
  （`TEMPLATE_CRAWLER_ADMINS`/`TASK_MONITOR_ADMINS`）兼容回退；
  任命管理员：`update user_profiles set role='admin' where oa_account='...'`
  （迁移见 `supabase/migrations/user_roles_is_admin.sql`）

## 返回字段

| 字段 | 含义 |
|---|---|
| `counts.completed` / `failed` | 窗口内生图任务完成/失败数 |
| `counts.completedOver60s` | **>60s 仍成功完成的任务数（修复生效的正面证据）** |
| `counts.killedTotal` | 被杀任务总数（`WorkerRequestCancelled` 特征） |
| `counts.killedAfterFix` | **修复部署时间之后仍被杀的数量（>0 即问题未根治）** |
| `maxCompletedDurationSec` | 窗口内最长成功耗时 |
| `longTaskSamples` | 最慢的最多 5 个成功样本（taskId/起止/耗时） |
| `recentFailures` | 最近 10 条失败明细（含 `killed` 标记与时长） |
| `conclusion` | 依据上述数据给出的一句话结论 |

被杀判定：`error` 或 `upstream_response` 中含 `WorkerRequestCancelled`
（main worker 在 supervisor 杀掉 user worker 后返回的
`500 {"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}`；
任务表 `error.message` 只有不带 `message` 键可读的兜底文案，
原始响应已由前端 providerTransport 强制归档到 `upstream_response`）。

`FIX_DEPLOYED_AT` 常量（core.ts）为修复部署的大致 UTC 时间，函数据此划分
修复前/后被杀计数；如后续再次调整超时，更新该常量即可。

## 实现与部署

- 目录：`supabase/functions/task-monitor/{index.ts,core.ts,core.test.ts}`
- 单测：`node --test supabase/functions/task-monitor/core.test.ts`（21 条）
- 部署（自托管热加载）：`cp -r supabase/functions/task-monitor
  /home/mdc/codes/supabase/volumes/functions/`
- 只读聚合：仅两条 PostgREST 查询（failed/completed 两个切片），不写任何表；
  行数上限 2000/切片
