# Tasks

## 1. Implementation
- [x] 1.1 vendor Feedbackland main 到 `feedbackland/`（含 feedbackland-react workspace）
- [x] 1.2 认证改造 Firebase → Supabase Auth（supabase.ts / trpc.ts / use-auth / trpc-client /
  chat / claim / ask-ai / forgot-password / upsert-user 加固 / next.config / package.json /
  .env.example）
- [x] 1.3 `feedbackland/Dockerfile` + `deploy/feedbackland/docker-compose.yml`（8090:3000）
- [x] 1.4 release.yml deploy job 追加 Feedbackland 构建与部署；.gitlab-ci.yml 补 FL_* 变量说明
- [x] 1.5 `FEEDBACKLAND_URL` 常量指向 `http://10.37.80.25:8090`
- [x] 1.6 文档：README / CHANGELOG / openspec 提案

## 2. Verification
- [ ] 2.1 vendored 应用本地 typecheck / build 通过
- [ ] 2.2 opentu 全量回归（nx run-many -t=test）通过
- [ ] 2.3 Supabase 连通性探测（网关 8021 / Postgres 5432 / 8090 端口）
- [ ] 2.4 生产侧数据准备（建 feedbackland 库 + schema.sql + images 桶）——待用户提供凭据后执行
- [ ] 2.5 发布流水线 deploy 阶段实际构建并启动容器（合并后由用户手动触发）

## 3. 需要用户提供
- GitLab CI 变量：FL_DATABASE_URL / FL_SUPABASE_URL / FL_SUPABASE_ANON_KEY /
  FL_SUPABASE_SERVICE_ROLE_KEY / FL_OPENROUTER_API_KEY（可选）
- 现有实例 Postgres 的管理凭据（用于建库/跑 schema）
