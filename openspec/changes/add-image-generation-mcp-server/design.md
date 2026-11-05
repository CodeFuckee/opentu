## Context

opentu 生图链路的服务端入口是 Supabase Edge Function `ai-proxy`
（`supabase/functions/ai-proxy/`）：校验用户 JWT → `consume_image_quota` 预扣配额 →
注入 `configs.NEWAPI_KEY` → 透传上游 new-api（tu-zi 网关）。前端另有本地任务队列、
IndexedDB 存储与交付归档线（上游 URL 下载转存 `ai-outputs` 公开桶 +
`task_submissions` 台账回写，见 `packages/drawnix/src/services/task-supabase-archive/`）。

仓库无对外 MCP 服务器先例；独立常驻服务先例为 `services/segment-server`
（自带依赖/Dockerfile/CI job/部署脚本，不入 pnpm workspace，不进 nx）。
生产 supabase 栈宿主机为 mdc@10.0.0.220（内网 Supabase 地址 `10.0.0.220:8021`，
ZCode 已验证 http 型 MCP 注册支持自定义 headers 鉴权）。

## Goals / Non-Goals

- Goals：agent 可经标准 MCP 工具生图；配额/台账与系统现有口径一致；稳定直链交付；
  零 DB/前端/ai-proxy 改动；部署可复制脚本化
- Non-Goals：异步图像模型（`/v1/videos`，受视频白名单门禁）、视频生成、
  多账号/多租户 MCP、画布内自动插入、multipart `/images/edits` 协议

## Decisions

- **语言运行时：Node 20 ESM 纯 JS（零构建）+ `@modelcontextprotocol/sdk`**
  - 理由：MCP 官方 SDK 传输层（streamable HTTP/stdio）成熟；仓库主体 TS 但
    services/ 在 pnpm workspace 之外，纯 JS 免构建链（`node --test` 直跑，
    与 `test:backend` 同款）；不用 Python（官方 SDK 亦可用，但仓库前端生态为 Node，
    且本服务纯 IO 无推理需求）
- **transport：stateless streamable HTTP 为主（每请求新建 server+transport 实例），
  stdio 为辅（`--stdio`）**
  - 理由：无状态模式免会话表管理，重启不丢会话；ZCode http 注册即插即用
- **身份：单个 supabase 账号 email+password 登录（复用用户个人账号，用户已确认）**
  - 理由：ai-proxy 按用户 JWT 计量配额/记账，服务端持 service_role 会绕过计量；
    密码登录 + 到期刷新（30s 提前量）+ 401 强制重登，语义同前端
    `apps/web/src/supabase/auth-context.tsx:78-92`
- **同步生图协议：JSON `{model,prompt,n,size,quality,image[]}` 单端点**
  - 理由：与前端 tuzi-gpt-image 适配器同协议（`tuzi-gpt-image-adapter.ts:75-127`），
    官方 `/images/edits` multipart 仅为 GPT Image 编辑专用 schema，首版不做
- **交付：下载转存 `ai-outputs` 公开桶 + `task_submissions` 台账；不做 huabu 副本**
  - 理由：URL 型结果的交付线前端本就只转存 ai-outputs（huabu 用于输入图与 b64
    响应归档）；MCP 无本地 SW 缓存语境，公开直链即稳定交付；台账 upsert 复用
    PostgREST `on_conflict=user_id,task_id`，用户 JWT 满足 RLS
- **鉴权：静态 Bearer token（`MCP_AUTH_TOKEN`）**
  - 理由：内网部署，单管理员场景；避免引入 OAuth/每用户账号体系

## Risks / Trade-offs

- 密码失效/被改 → 服务不可用：README 写明轮换流程（改 env 重启容器）；
  冒烟脚本可快速定位凭据类失败
- 单账号配额耗尽 → check_quota 工具 + quota_exceeded 明确报错，行为与前端一致
- 上游 URL 下载失败（防盗链升级）→ 回退返回上游原始 URL 并标记 archived=false
  （与前端「归档失败不阻塞交付」一致）；上游持续不可用属上游故障
- 该机 Docker Hub 不通 → Dockerfile `ARG BASE_IMAGE` 支持部署脚本注入镜像源前缀
  （library 镜像经 docker.1ms.run / docker.m.daocloud.io 可拉，机器实证）

## Migration Plan

全新服务，无存量迁移。回滚 = 停止并删除容器 `yue-image-mcp`、删除部署目录，
不触碰 web/supabase 现有栈。

## Open Questions

无（账号语义/模型范围/部署形态已经用户确认：个人账号、仅同步模型、mdc 服务器 8301）。
