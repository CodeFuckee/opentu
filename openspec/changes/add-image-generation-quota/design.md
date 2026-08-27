# Design: 生图月度额度管控

## 架构

```
浏览器(Yue画布, 不再持有 API Key)
   │  Authorization: Bearer <Supabase JWT>
   │  request.path/body 原样透传
   ▼
边缘函数 ai-proxy (自建 Supabase)
   1. JWT → GET /auth/v1/user 验证，取可信 uid
   2. RPC consume_image_quota：单语句原子扣减，超限返回 403（含剩余额度）
   3. service_role 读 user_profiles.apikey 注入 Bearer 头
   4. 转发到 configs.NEWAPI_URL 指向的自建 new-api，结果原样返回
```

## 决策

### 为什么在 provider-transport 层改写，而不是各组件各自接代理

全部生图调用点（AI 弹窗、批量弹窗、画布输入栏、漫画创作、图片填充等约 18 处）
最终都收敛到 `providerTransport.send()`。在这一层做 URL/鉴权头改写，
多协议适配器（同步 images、异步表单轮询、MJ、Gemini 协议）零改动。
代理只透传 path+query+body，不解析业务协议，因此后续新增模型协议不需要动管控层。

### 实现决策：托管态下全量隧道，而非逐请求打计费标记

规划阶段曾计划在各执行器提交点为异步/MJ/Gemini 图像请求补客户端 billing 标记。
实现时发现：一旦部分上游流量走代理而轮询不走，浏览器缺失 key 的轮询请求必然 401，
必须保证同一任务管线内所有请求同路；而逐文件追加标记既易遗漏也无安全增益
（代理本就以服务端路径白名单为准）。最终方案：托管启用时把 provider-transport 的
**全部**上游请求隧道到 ai-proxy（文本/音频同样透传不计量），生图计量完全由服务端
判定（路径白名单 + body 模型名/modalities 浅解析）。前端执行栈因此零散改动为零。

### 计费规则（v1 近似）

| 路径 | 计费 | 说明 |
|---|---|---|
| `POST /v1/images/generations` `/v1/images/edits` | `body.n`（默认1，上限10） | 同步出图 |
| `POST /v1/mj/submit/*` | 1 | MJ 提交即计 |
| 异步图像提交（表单到 `/v1/videos` 等 async.image.form） | 1，记 pending | 任务创建时计 |
| Gemini 图像协议（流式） | 1/请求 | 无法预知张数，按请求近似 |
| 上游响应 ≥400 | 全额退回 | 同步类立即退；提交类退为无 pending |
| 轮询响应终态 FAILED/CANCELLED/EXPIRED | 一次性退回 | 以 pending 表行存在为准防重复 |

视频/音频/文本请求直接透传不计数。路径分类是服务端白名单，前端标记仅作提示。

### 月度边界与限额来源

惰性计算：以 `date_trunc('month', now() at time zone 'Asia/Shanghai')` 所在自然月为周期,
无需定时任务。行不存在按需 INSERT。限额读取顺序:
部门覆盖（`department_configs` key=`image_monthly_quota_{department}`）→
全局（key=`image_monthly_quota_default`）→ 缺省 200。

### 失败与幂等

- 扣减与转发的窗口内发生网络错误：同步类在收到上游失败响应后退回；
  若代理自身崩溃未产生响应，该次消耗计入用户（可由管理员手工 refund），概率极低可接受。
- 安全定义的 SQL 函数只在 service_role 下 EXECUTE，不给 anon/authenticated 直调入口，
  前端一切配额读写经由 ai-proxy（JWT 保护）。

## 已知限制

- 自托管 edge-runtime 容器对单请求有时长上限，长轮询任务（MJ 大队列）极端情况可能触顶；
  后续可演进为"提交返 jobId、结果落库"模式。
- 流式 Gemini 图像无法精确计量张数，v1 按 1 次/请求近似。
