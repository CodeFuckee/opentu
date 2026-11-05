## ADDED Requirements

### Requirement: MCP 工具集

系统 SHALL 通过独立 MCP 服务器提供以下工具：

1. `generate_image`：根据提示词生成图片。参数 SHALL 支持 `prompt`（必填）、
   `model`（默认 `gpt-image-2`）、`size`（比例别名 `1x1`/`16x9`/`9x16` 等或像素串，
   语义与前端 `ASPECT_RATIO_TO_SIZE` 一致）、`n`（1-10，默认 1）、
   `quality`（`auto`/`low`/`medium`/`high`）、`reference_images`（URL 或 data URL 数组，
   提供时为图生图，走 JSON `image[]` 协议）、`return_base64`（布尔，true 时结果含
   image content block）。
2. `list_models`：返回当前可用的同步生图模型清单（来源 `model_catalog` 表
   `enabled=true` 且类型为 image 的行）。
3. `check_quota`：返回当前账号生图配额（limit/used/remaining/period）。

#### Scenario: 文生图成功

- **WHEN** agent 调用 `generate_image` 传 `prompt` 与 `size=16x9`
- **THEN** 服务器经 ai-proxy 以 `{model, prompt, n, size:"1792x1024"}` 请求上游，
  成功后返回包含稳定公开直链的结果

#### Scenario: 图生图成功

- **WHEN** agent 调用 `generate_image` 传 `prompt` 与 `reference_images`
- **THEN** 请求体包含 `image` 数组（原样透传 URL/data URL），其余同文生图

#### Scenario: 配额超限

- **WHEN** ai-proxy 返回 403 且 `error=quota_exceeded`
- **THEN** 工具返回明确错误文案，不产生部分结果，`task_submissions` 记 failed

### Requirement: 传输与鉴权

服务器 SHALL 支持 streamable HTTP（路径 `/mcp`，无状态模式）与 stdio 两种 transport。
HTTP 模式 SHALL 校验 `Authorization: Bearer <MCP_AUTH_TOKEN>`，不匹配返回 401；
`/health` 端点 SHALL 免鉴权供容器健康检查。

#### Scenario: token 正确

- **WHEN** 客户端携带正确 Bearer token 调用 `/mcp`
- **THEN** 请求正常进入 MCP 协议处理

#### Scenario: token 缺失或错误

- **WHEN** 客户端未携带或不携带正确 token 调用 `/mcp`
- **THEN** 返回 401，不执行任何工具

### Requirement: 托管生图链路复用

服务器 SHALL 以配置的 supabase 账号（email + password 登录，access_token 到期前
自动刷新、失效自动重登）获取 JWT，向 `{SUPABASE_URL}/functions/v1/ai-proxy`
发起生图请求，并 SHALL 携带 `x-task-id`（uuid）头用于对账。上游网关密钥注入、
配额扣减/退还 SHALL 完全复用 ai-proxy 现有逻辑，服务器不直接持有上游 API Key。

#### Scenario: 配额正确计量

- **WHEN** `generate_image` 以 n=2 请求成功
- **THEN** 配额经 ai-proxy `consume_image_quota` 按账号计量扣减 2（服务器零额外逻辑）

#### Scenario: token 过期自愈

- **WHEN** 缓存的 access_token 已过期或 ai-proxy 返回 401
- **THEN** 服务器自动刷新（失败则重登）后重试，工具调用最终成功或返回明确错误

### Requirement: 稳定交付与台账

对每次成功生图的每个结果，服务器 SHALL：下载上游字节（UA 伪装 + 最多 4 次退避重试 +
图片魔数严格校验，校验失败按归档失败处理）→ 以内容寻址路径
`{sanitizeUsername(邮箱前缀)}/{YYYY-MM-DD}/{sha256}.{ext}` 上传 `ai-outputs` 公开桶 →
返回 `{SUPABASE_URL}/storage/v1/object/public/ai-outputs/{路径}` 稳定直链。
服务器 SHALL 在任务创建时与终态时 upsert `task_submissions`
（unique(user_id, task_id)，status: submitted→completed/failed），
使 MCP 生图记录在系统任务台账可见。

#### Scenario: 上游 URL 失效兜底

- **WHEN** 上游返回的图片 URL 下载失败（重试耗尽或非图片字节）
- **THEN** 该结果回退返回上游原始 URL 并在结果中标记 `archived=false`，任务不因此整体失败

#### Scenario: 台账完整

- **WHEN** 一次 generate_image 成功完成
- **THEN** `task_submissions` 存在对应行（type=image, status=completed，
  result 含 url/source_url/size/model）

### Requirement: 模型范围（首版仅同步）

首版 SHALL 仅支持同步生图模型（`/v1/images/generations` JSON 协议）。
当请求模型名命中异步图像模型（`gemini-3-pro-image-preview-*-async` 族）时，
工具 SHALL 返回明确错误（说明异步模型当前经 MCP 不可用），不发起上游请求。

#### Scenario: 异步模型被拒

- **WHEN** agent 请求 `model=gemini-3-pro-image-preview-2k-async`
- **THEN** 返回错误说明该模型走 /v1/videos 受视频白名单门禁、MCP 首版不支持，
  建议改用同步模型；不消耗配额

### Requirement: 部署形态

服务器 SHALL 以 docker 容器部署于 mdc@10.0.0.220（端口 8301，
`--restart unless-stopped`），凭据与 token 经宿主机 env 文件（0600）注入，
不入代码库。部署 SHALL 附带健康检查与全链路冒烟脚本。

#### Scenario: 健康检查

- **WHEN** 容器启动后请求 `GET /health`
- **THEN** 返回 200（含进程与配置概要，不含密钥）

#### Scenario: 冒烟全链路

- **WHEN** 执行冒烟脚本（initialize → tools/list → check_quota → generate_image 一张）
- **THEN** 各步成功，产出一可供 agent 直接访问的稳定图片直链
