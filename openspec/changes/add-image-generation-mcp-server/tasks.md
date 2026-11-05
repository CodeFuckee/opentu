## 1. 服务本体（services/mcp-server）

- [x] 1.1 package.json（ESM，deps：@modelcontextprotocol/sdk、zod）+ Dockerfile + README
- [x] 1.2 src/config.js 环境解析 + src/util.js（尺寸映射/sanitizeUsername/sha256/魔数校验/退避重试）
- [x] 1.3 src/supabase-auth.js（signInWithPassword + 刷新 + 失效重登）
- [x] 1.4 src/ai-proxy-client.js（generations/quota + x-task-id + 401 重试）
- [x] 1.5 src/media-store.js（下载转存 ai-outputs + task_submissions 台账）
- [x] 1.6 src/tools.js（generate_image / list_models / check_quota）
- [x] 1.7 src/server.js（streamable HTTP /mcp + token 鉴权 + /health + --stdio）

## 2. 测试

- [x] 2.1 tests/：util / supabase-auth / ai-proxy-client / media-store / tools（node --test，fetch 全 mock）
- [x] 2.2 本地全绿 + 本机冒烟（stdio + http 各一次）

## 3. CI 与部署

- [x] 3.1 .gitlab/ci/quality-test.yml 加 test:image-mcp-server
- [x] 3.2 scripts/deploy-image-mcp-server.sh + scripts/smoke-image-mcp-server.sh

## 4. 交付

- [x] 4.1 CHANGELOG.md Unreleased 条目
- [x] 4.2 推送 main → 监控流水线全绿
- [x] 4.3 部署 mdc + 冒烟 + ZCode 注册 + 端到端真实生图过目
