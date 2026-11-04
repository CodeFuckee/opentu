# ai-proxy 边缘函数：生图额度管控与视频使用权白名单代理

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
   ├─ 3. 读取 configs.NEWAPI_KEY 注入 Authorization 后转发到 configs.NEWAPI_URL
   ├─ 4. 上游响应透传；≥400 自动退回额度；异步任务终态失败一次性退回
   └─ 5. 响应归档（请求携带 `x-task-id` 头时）：同步生图成功 / 异步轮询终态 /
          ≥400 失败响应 → 原始 JSON 写入 `task_submissions.upstream_response`，
          JSON 内 base64（b64_json/b64/base64/dataURL）转存 `huabu` bucket 并以
          存储路径替换（详见下文"响应归档"）
```

效果：
- **API Key 不再下发到浏览器**，无法绕开页面直连中转站滥用；
- 每用户每自然月生图 ≤200 张（限额解析顺序：**用户级覆盖 `user_quota_configs`** →
  部门覆盖 `department_configs` → 全局 `image_monthly_quota_default` → 缺省 200）；
- **视频模型按白名单管控**（`video_model_access` 表，上线即收紧：名单内用户或
  管理员可用，其余视频提交一律 403，详见下文专节）；
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

## 响应归档（task_submissions.upstream_response，前端执行）

**提醒**：响应归档已从前端改为在**前端 `providerTransport`** 完成（方案调整，原因见下）。
ai-proxy 只做纯透传 + 配额/记账/退款，**不再在请求生命周期内 await 归档**。

背景：早期版本 ai-proxy 在同步生图成功 / 异步轮询终态 / ≥400 失败时，于请求内 `await` 读取
响应体、解码多 MB base64、上传 `huabu` bucket、写 `task_submissions`，把请求总时长拖爆
edge-runtime CPU/墙钟硬限制 → supervisor 取消 worker → 客户端收到
`500 {"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}`，
且被杀的归档写不进 bucket（任务图片丢失）。修复后：

- 前端 `providerTransport.send()`（托管模式 + 携带 taskId）在拿到上游响应时，
  clone 响应后 **fire-and-forget** 归档（`archiveUpstreamResponseFromFetch`）：
  - 同步生图成功（响应含 `b64_json`/`b64`/`base64`/dataURL）→ base64 转存 `huabu`
    bucket（`output-` 前缀）+ 写 `upstream_response`/`response_file_paths`；
  - 异步轮询终态（`status`/`state` 为 completed/failed 等）→ 归档终态 JSON；
  - 上游 ≥400 失败响应 → 强制归档错误 JSON；
  - 中间态轮询（queued/processing）与非 JSON 响应跳过；
- 传输层不阻塞：clone 读取不消费原响应，归档全异步、静默失败；
- `x-task-id` 头仍按契约随请求附加（兼容老前端/排查用），但服务端不再消费。

实现见 `packages/drawnix/src/services/task-supabase-archive/{core,service}.ts`
（`archiveUpstreamResponseToSupabase` / `archiveUpstreamResponseFromFetch`），
迁移 `supabase/migrations/task_submissions_add_upstream_response.sql` 不变。

## 数据库依赖（先执行迁移）

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage.sql
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/generation_usage_user_override.sql
```

迁移内容：`generation_usage` 用量表、`generation_task_bills` 异步记账表、
配额函数（`consume_image_quota` / `refund_image_quota` / `get_image_quota` /
`record_task_bill` / `refund_task_bill`）、RLS 与 service_role 权限收口；
`generation_usage_user_override.sql` 追加**用户级额度覆盖**（`user_quota_configs`
表 + 管理员总览视图 `user_quota_overview`）。
⚠️ 若之后重新执行 `generation_usage.sql`，会回退用户级覆盖的函数改动，
需要再执行一次 `generation_usage_user_override.sql`。

### 可选配置（configs 表）

| key | 说明 |
|---|---|
| `NEWAPI_URL` | **必需**，自建 new-api 地址（已有） |
| `ASYNC_IMAGE_MODEL_PATTERN` | 正则，识别异步图像表单提交的模型名，缺省 `image` |
| `LOCAL_VIDEO_GATEWAY_URL` | 本地视频网关基地址（如 `http://10.0.0.220:8788`）；**缺省不配置 = 分流功能关闭** |
| `LOCAL_VIDEO_MODEL_PATTERN` | 命中该正则（不区分大小写）的模型名走本地网关，如 `^MiniMax-H3$`；缺省不分流 |
| `image_monthly_quota_default` | 全局月度限额，缺省 200 |
| `image_monthly_quota_{部门名}` | 部门级覆盖限额 |

插入示例：

```sql
insert into department_configs(key, value) values
  ('image_monthly_quota_default', '200'),
  ('image_monthly_quota_设计部', '500')
on conflict (key) do update set value = excluded.value;
```

### 用户级额度覆盖（在 Supabase 里给特定用户调限额）

限额解析顺序（每次生图/查额度实时解析，改完即生效，无需重启）：

```
user_quota_configs（用户级，优先级最高）
  → department_configs: image_monthly_quota_{部门名}
  → department_configs: image_monthly_quota_default
  → 缺省 200
```

管理员操作（Supabase Dashboard → Table Editor → `user_quota_configs`）：

1. 找到用户 UUID：查 `user_quota_overview` 视图（含 email / oa_account / 部门 /
   当月用量与生效限额），或
   `select user_id from user_profiles where oa_account = 'zhangsan';`
2. 给该用户插一行（如调到 1000 张/月）：`user_id = <用户UUID>`、`quota_limit = 1000`；
   已有行直接改 `quota_limit`；
3. **删除该用户的行 = 回退**到部门/全局默认限额。

注意：

- `quota_limit` 必须 > 0；把限额调到低于当月已用量时，该用户本月剩余额度立即变 0
  （次月恢复按新限额）；
- `user_quota_configs` / `user_quota_overview` 均不授予 anon/authenticated，
  只能经 Dashboard（表属主）或 service_role 访问，普通用户无法读取他人配额。

## 视频模型使用权白名单（2026-11 新增，上线即收紧）

视频生成（全部视频模型统一门禁）按 **白名单 + 管理员** 管控，服务端硬拦截：

```
浏览器 POST …/videos（/v1/videos、/kling/v1/videos/text2video|image2video、
happyhorse /videos 等所有视频适配器提交端点）
   │
   ├─ ai-proxy 转发前调 RPC has_video_model_access(p_user_id)
   │    ├─ video_model_access 表有该用户行 → 放行
   │    ├─ user_profiles.role = 'admin'    → 放行（管理员恒可用）
   │    └─ 其余 → 403 {error:'video_access_denied'}，不调用上游
   └─ GET 轮询 /videos/{id} 不拦（无新增成本）
```

- 白名单表：`video_model_access`（user_id 主键 → auth.users、note 备注、时间戳）；
  RLS 不授予任何客户端角色，**名单不对前端暴露**；
- 前端自查：`GET /functions/v1/ai-proxy/video-access` 返回当前用户 `{allowed}`；
  视频对话框打开时自查，无权限禁用生成按钮并提示；其余入口（MV Creator /
  AI 输入条 / MCP 工具）由代理 403 经 `VideoAccessDeniedError` 在任务队列展示；
- 边界：门禁只约束经 ai-proxy 的托管调用（登录用户）；用户自配 baseUrl/apiKey
  直连上游不经代理，与生图额度同一边界。

迁移与管理（Supabase Dashboard → Table Editor → `video_model_access`）：

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/video_model_access.sql
```

1. 找到用户 UUID：`select user_id from user_profiles where oa_account = 'zhangsan';`
   （或 Dashboard Authentication 页查看）；
2. 给可用的用户各插一行：`user_id = <用户UUID>`（note 可填部门/原因）；
   **删除行 = 该用户立即拒用**（管理员除外）；
3. ⚠️ 上线即收紧：部署新版 ai-proxy 之前，先在表里加好初始名单
   （管理员账号本就豁免，普通用户不加行即被拒）。

## 本地视频网关分流（MiniMax H3，2026-11 新增）

服务器本地部署的 MiniMax H3 视频网关（`~/h3-video/`，ComfyUI 后端，端口 8788）
按 **模型名分流** 接入：命中 `LOCAL_VIDEO_MODEL_PATTERN` 的请求改转
`LOCAL_VIDEO_GATEWAY_URL`，其余流量不受影响：

```
POST …/videos（视频提交）
   ├─ 解析表单/JSON 的 model（复用计费分类的解析）
   ├─ model 命中 LOCAL_VIDEO_MODEL_PATTERN（不区分大小写）
   │    → 转发 LOCAL_VIDEO_GATEWAY_URL（仍先过视频使用权白名单门禁）
   └─ 未命中/未配置 → 默认转发 NEWAPI_URL（行为不变）

GET …/videos/{id}、GET …/videos/{id}/content（轮询/取流）
   ├─ 按任务路由表 local_video_task_routes 记录的提交模型判定
   │    → 命中 → 转发本地网关；无记录/未命中 → 默认 NEWAPI_URL
   └─ /content 为二进制透传（不进入终态检测缓冲，mp4 不损坏）
```

- 计费语义不变：本地视频同样不计费、不扣额度（白名单门禁仍生效）；
- 路由记录只在提交成功且命中分流时写入（量小，不参与退额）；
- 功能开关 = 是否配置 `LOCAL_VIDEO_GATEWAY_URL`（未配置时两条配置都不读，
  零额外开销，行为与旧版完全一致）；
- 分流模式建议锚定（如 `^MiniMax-H3$`），避免误吞第三方中转的同前缀模型
  （tu-zi 网关上有 MiniMax-H3 / MiniMax-H3-Context-IR 等 API 中转模型）。

迁移（含两条 configs 幂等写入 + 路由表 + RPC）：

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/local_video_gateway.sql
```

⚠️ 部署顺序：先上线前端（含 minimax-h3 adapter）与 ai-proxy，再应用本迁移的
configs 写入（迁移文件可提前执行表结构部分）；pattern 生效前老前端不会提交
命中模型，无副作用。

## 超时配置（2026-09-15 调整，服务器侧）

同步生图经 ai-proxy 在 edge-runtime 内等待上游完成（可达数分钟），链路上有三个
超时闸门，均已按 15 分钟对齐（与前端 `IMAGE_GENERATION_TIMEOUT_MS` 一致）：

| 层 | 文件（服务器） | 参数 | 原值 → 新值 |
|---|---|---|---|
| edge-runtime user worker | `volumes/functions/main/index.ts` | `workerTimeoutMs` | `60_000` → `900_000` |
| Envoy 路由总超时 | `volumes/api/envoy/lds.template.yaml` | functions-v1-all `route.timeout` | `150s` → `920s` |
| Envoy 流空闲超时 | 同上 | functions-v1-all `route.stream_idle_timeout` | 默认 300s → `0s` 禁用 |

背景：生图任务曾「超 1 分钟必失败」——user worker 60s 被 supervisor 终止，客户端收到
`500 {"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}`
（`msg` 键不被前端 `readErrorMessage` 的 `error`/`error.message`/`message` 三重判断
识别，显示为兜底文案「Tuzi GPT Image request failed: 500」），而上游 tuzi 侧生成
照常完成并计费；且 worker 被杀时 ai-proxy 走不到「上游 ≥400 退回额度」分支，月度
生图额度被白扣（补偿待办）。

运维要点：

- 改 `lds.template.yaml` 后必须重启 `supabase-envoy`（容器入口脚本用 envsubst 由
  模板生成实际生效的 `/etc/envoy/lds.yaml`）；
- 改 `main/index.ts` 后重启 `supabase-edge-functions`；
- 同日变更前的文件备份为同目录 `*.bak-20260915`，回滚即恢复备份 + 重启对应容器；
- 验证方法：部署临时 sleep 函数（如 120s 后返回 200）curl
  `/functions/v1/<name>`，修复前必死于 60s；另可用 ai-proxy `/v1/models`
  （免费、不计生图额度）冒烟整条代理链路；
- 待办：前端 `readErrorMessage` 增补对 `msg` 键的识别，把真实取消原因透到任务表。

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
7. 异步图像任务：提交成功、轮询到 failed → 记账行 `refunded=true`，额度恢复；
8. 用户级覆盖：给测试用户插入 `user_quota_configs(user_id, quota_limit=3)` →
   `get_image_quota` 立即返回 `limit=3` → 生成第 4 张被 403 → 删除该行后恢复
   部门/全局限额；`user_quota_overview` 视图中 override_limit/effective_limit 正确。
9. 视频白名单：不在名单的用户（非 admin）经代理 POST `/v1/videos` → 403
   video_access_denied 且无上游调用，画布视频对话框提示"权限未开放"且生成按钮
   置灰；给该用户在 `video_model_access` 插行后立即恢复；`GET
   .../functions/v1/ai-proxy/video-access` 返回 `{allowed:true/false}` 与名单一致。

## 回滚

前端回滚开关即"登出即旧路径"；如需服务端紧急熔断，将 `department_configs`
的 `image_monthly_quota_default` 设为大值即可放行全部流量（若只想放开个别用户，
直接在 `user_quota_configs` 给该用户插大额覆盖行即可），再删除
volumes/functions/ai-proxy 目录并刷新即可彻底下线（其余函数不受影响）。
如需回退用户级覆盖改造，重新执行 `generation_usage.sql` 即可恢复旧解析链
（之后若又要用户级覆盖，需再执行 `generation_usage_user_override.sql`）。
