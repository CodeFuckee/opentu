# yue-image MCP 服务器（services/mcp-server）

把 Yu画布（opentu）的生图能力以标准 MCP 工具暴露给外部 AI agent。
生图走托管链路：以配置的 supabase 账号经 Edge Function
[`ai-proxy`](../../supabase/functions/ai-proxy/) 调上游——网关密钥注入、配额扣减
全部复用现有逻辑，本服务不持有上游 API Key。

- 规格：`openspec/changes/add-image-generation-mcp-server/`（含已归档 capability
  `image-generation-mcp`）
- Node ≥20，ESM 纯 JS 零构建；依赖仅 `@modelcontextprotocol/sdk` + `zod`

## 工具

| 工具 | 说明 |
| --- | --- |
| `generate_image` | 文生图/图生图。参数：`prompt`（必填）、`model`（默认 `gpt-image-2`）、`size`（`1x1`/`16x9`/`9x16` 等别名或像素串）、`n`（1-10）、`quality`（auto/low/medium/high）、`reference_images`（URL/data URL 数组）、`return_base64`。返回 `ai-outputs` 公开桶稳定直链 |
| `list_models` | 同步生图模型清单（`model_catalog` 表 enabled+image 行，异步模型过滤标注） |
| `check_quota` | 当前账号本月生图配额（limit/used/remaining/period） |

首版**仅支持同步模型**；异步图像模型（`gemini-3-pro-image-preview-*-async`，走
`/v1/videos`，受 `video_model_access` 白名单门禁）显式拒绝。

## 交付语义

每次成功生图：上游 URL 下载（浏览器 UA + 4 次退避重试 + 图片魔数严格校验）→
转存 `ai-outputs` 公开桶 `{用户名}/{YYYY-MM-DD}/{sha256}.{ext}` → 返回
`{SUPABASE_URL}/storage/v1/object/public/ai-outputs/{路径}` 直链；
下载/上传失败回退上游原始 URL（`archived=false`），不阻塞交付。
任务创建/终态 upsert `task_submissions`（在画布任务台账可见，配额记账同一账号）。

## 配置（环境变量）

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `SUPABASE_URL` | 是 | 内网 Supabase 地址（生产 `http://10.0.0.220:8021`） |
| `SUPABASE_ANON_KEY` | 是 | anon key（登录/匿名读目录用，非机密；可从 supabase 栈 `.env` 的 `ANON_KEY` 取） |
| `SUPABASE_EMAIL` / `SUPABASE_PASSWORD` | 是 | 生图账号（当前为用户个人账号，配额计入该账号；**密码只放部署宿主机 env 文件**） |
| `MCP_AUTH_TOKEN` | HTTP 模式必填 | 服务器自身鉴权 Bearer token（agent 注册时携带） |
| `MCP_PORT` | 否 | 监听端口，默认 8301 |
| `MCP_REQUEST_TIMEOUT_MS` | 否 | ai-proxy 请求超时，默认 600000（同步生图可长达数分钟） |
| `MCP_DEFAULT_IMAGE_MODEL` | 否 | 默认模型，默认 `gpt-image-2` |

## 运行

```bash
# 本机开发
npm install
npm test                          # node --test，fetch 全 mock 不连网
SUPABASE_URL=... npm start        # HTTP 模式（/mcp + /health）
SUPABASE_URL=... npm run start:stdio   # stdio 模式（token 不必需）
```

```bash
# 生产（Docker）
docker run -d --name yue-image-mcp --restart unless-stopped \
  -p 8301:8301 --env-file ~/image-mcp.env \
  yue-image-mcp:latest
# 健康检查
curl http://127.0.0.1:8301/health
```

生产部署/冒烟用仓库脚本（目标 mdc@10.0.0.220）：
`scripts/deploy-image-mcp-server.sh`、`scripts/smoke-image-mcp-server.sh`。
凭据 env 文件在宿主机 `~/image-mcp.env`（0600），由账号本人填写，agent 不经手明文。

## agent 接入（ZCode 为例）

`~/.zcode/cli/config.json` → `mcp.servers` 增加（timeout 须放宽，生图可达数分钟）：

```json
"yue-image": {
  "type": "http",
  "url": "http://10.0.0.220:8301/mcp",
  "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" },
  "timeoutMs": 300000
}
```

## 运维注意

- **密码轮换**：改 `~/image-mcp.env` 的 `SUPABASE_PASSWORD` 后
  `docker restart yue-image-mcp`；密码错误时工具报「supabase 登录/刷新失败」。
- **配额耗尽**：`check_quota` 查看明细；与画布端同账号共享月度额度
  （`generation_usage`，解析顺序见 `generation_usage_user_override.sql`）。
- **回滚**：`docker rm -f yue-image-mcp` 即可，不触碰 web/supabase 现有栈。
