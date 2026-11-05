# Change: add-image-generation-mcp-server（生图 MCP 服务器）

## Why

opentu 的生图链路（前端 → Supabase Edge Function `ai-proxy` → tu-zi 网关）只服务浏览器：
外部 AI agent（ZCode 等）无法以标准方式调用系统能力。需要一个独立 MCP 服务器把
生图暴露为标准 MCP 工具，供内网各设备的 agent 接入使用。

## What Changes

- 新增独立服务 `services/mcp-server/`（Node 20 ESM 纯 JS + `@modelcontextprotocol/sdk`，
  不入 pnpm workspace，照 `services/segment-server` 先例）：
  - MCP 工具：`generate_image`（文生图/图生图）、`list_models`（同步生图模型清单）、
    `check_quota`（生图配额自查）
  - 双 transport：streamable HTTP（`/mcp`，Bearer token 鉴权）+ `--stdio` 本机模式
  - 生图复用托管链路：以配置的 supabase 账号经 `ai-proxy` 调上游
    （`POST /v1/images/generations`，配额计量、密钥注入全部复用，零 DB 改动）
  - 稳定交付：上游结果下载（UA 伪装 + 退避重试 + 魔数严格校验）→ 转存 `ai-outputs`
    公开桶返回稳定直链 → `task_submissions` 台账 upsert（submitted→completed/failed）
  - 首版仅同步模型；异步图像模型（走 `/v1/videos`，受视频白名单门禁）显式拒绝并提示
- CI 新增 `test:image-mcp-server` job（`node --test`，照 `test:segment-server` 模式）
- 部署脚本 `scripts/deploy-image-mcp-server.sh` + 冒烟脚本 `scripts/smoke-image-mcp-server.sh`
  （目标：mdc@10.0.0.220 docker，端口 8301）

## Impact

- Affected specs: 新增 `image-generation-mcp`（specs/specs.md 尚无该 capability）
- Affected code: `services/mcp-server/**`（新）、`.gitlab/ci/quality-test.yml`（+1 job）、
  `scripts/deploy-image-mcp-server.sh`、`scripts/smoke-image-mcp-server.sh`（新）
- 不改动：前端代码、`supabase/functions/ai-proxy`、数据库 schema
- 账号语义：服务以配置的单个 supabase 账号（用户个人账号）运行，配额计入该账号；
  凭据仅存部署宿主机 env 文件（0600），不入库
