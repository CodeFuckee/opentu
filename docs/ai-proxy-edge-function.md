# ai-proxy 边缘函数：生图额度管控代理

对应 OpenSpec 变更：`openspec/changes/add-image-generation-quota/`

## 功能概述

`ai-proxy` 是自建 Supabase 上的通用 AI 上游代理。已登录用户的画布所有上游请求
（生图、文本、音频等）不再从浏览器直连中转站，而是：

```
浏览器（只带 Supabase JWT）
   │  Authorization: Bearer <JWT>
   ▼
POST http://<SUPABASE_URL>/functions/v1/ai-proxy/<原上游路径>?<query>
   │
   ├─ 1. 校验 JWT → GET /auth/v1/user 取得可信 user_id（失败返回 401）
   ├─ 2. 判定是否为"图像提交"→ RPC consume_image_quota 原子扣减当月张数
   │      （超限返回 403 {error:'quota_exceeded'}，不调用上游）
   ├─ 3. 读取 user_profiles.apikey 注入 Authorization 后转发到 configs.NEWAPI_URL
   └─ 4. 上游响应透传；≥400 自动退回额度；异步任务终态失败一次性退回
```

效果：
- **API Key 不再下发到浏览器**，无法绕开页面直连中转站滥用；
- 每用户每自然月生图 ≤200 张（可按部门在 `department_configs` 覆盖）；
- 失败自动退额度；月度边界惰性计算，无需定时任务；
- 未登录（或托管未启用）行为完全不变：仍走本地直连 + 用户手填 Key。

## 计费规则

| 请求 | 扣减 | 备注 |
|---|---|---|
| `POST …/images/generations` | `body.n`（默认1，上限10） | 同步出图 |
| `POST …/images/edits` | 1 | 图片编辑 |
| `POST …mj/submit*` | 1 | 成功后记账，MJ 终态失败退回 |
| `POST …/videos` 且模型命中异步图像模式 | 1 | 由模型名判定，视频模型不计费 |
| Google 协议 `:generateContent/:streamGenerateContent` 且含 IMAGE 模态 | 1 | 按请求近似 |
| 其余（文本/音频/视频） | 0 | 纯透传 |

异步图像任务的轮询响应若出现终态失败（failed/cancelled/expired 等），按记账行
一次性退回（防重复）。同步类上游 ≥400 立即全额退回。

## 数据库依赖（先执行迁移）

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage.sql
```

迁移内容：`generation_usage` 用量表、`generation_task_bills` 异步记账表、
配额函数（`consume_image_quota` / `refund_image_quota` / `get_image_quota` /
`record_task_bill` / `refund_task_bill`）、RLS 与 service_role 权限收口。

### 可选配置（configs 表）

| key | 说明 |
|---|---|
| `NEWAPI_URL` | **必需**，自建 new-api 地址（已有） |
| `ASYNC_IMAGE_MODEL_PATTERN` | 正则，识别异步图像表单提交的模型名，缺省 `image` |
| `image_monthly_quota_default` | 全局月度限额，缺省 200 |
| `image_monthly_quota_{部门名}` | 部门级覆盖限额 |

插入示例：

```sql
insert into department_configs(key, value) values
  ('image_monthly_quota_default', '200'),
  ('image_monthly_quota_设计部', '500')
on conflict (key) do update set value = excluded.value;
```

## 部署

与现有函数一致（热加载，无需重启容器）：

```bash
cp -r supabase/functions/ai-proxy /home/mdc/codes/supabase/volumes/functions/
# 容器内环境变量 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 已就绪，无新增环境变量
```

前端无需单独配置：`VITE_SUPABASE_URL` 即为代理根地址。

## 单测

```bash
cd supabase/functions/ai-proxy && node --test core.test.ts
```

## 验收清单

1. 迁移执行后：
   `select * from get_image_quota('<某用户uuid>');` 返回 `{limit:200,...}`
2. 未带 JWT curl 代理任意路径 → 401；
3. 带有效 JWT 调 `GET .../functions/v1/ai-proxy/quota` → 200 返回额度；
4. 先用该用户 key 直接 curl 内网 new-api `/v1/images/generations` 确认可出图，
   再通过代理发起同一请求 → 出图成功且 `generation_usage.used_count` 增加 n；
5. 把用户限额临时调到 5 后连续生成 >5 张 → 第 6 次返回 403 quota_exceeded，
   页面提示"本月图片生成额度已用完"，且未产生上游调用；
6. 人为构造上游 500（如临时改 NEWAPI_URL 指向不可达端口）→ 额度被退回；
7. 异步图像任务：提交成功、轮询到 failed → 记账行 `refunded=true`，额度恢复。

## 回滚

前端回滚开关即"登出即旧路径"；如需服务端紧急熔断，将 `department_configs`
的 `image_monthly_quota_default` 设为大值即可放行全部流量，再删除
volumes/functions/ai-proxy 目录并刷新即可彻底下线（其余函数不受影响）。
