# Change: Feedbackland 自托管 Docker 部署（Supabase Auth 认证改造 + CI/CD 一并部署）

## Why
侧边栏已新增 Feedbackland 反馈入口按钮（add-feedbackland-sidebar-entry），需要把
Feedbackland 实例真正部署起来。Feedbackland 官方只有 Vercel+Supabase+Firebase 的 PaaS
方案、无 Docker 支持；本项目将 fork 并容器化，认证从 Firebase 改为自托管 Supabase Auth
（复用现有自建 Supabase 10.37.80.25:8021 的认证/存储/Postgres），并在发布流水线 deploy
阶段与 opentu 一并构建部署。

## What Changes
- vendor Feedbackland main 源码到 `feedbackland/`（Next.js 16，含 feedbackland-react
  workspace），认证改造 Firebase → Supabase Auth（约 11 个文件）：
  删除 firebase/firebase-admin 依赖与 firebaseConfig/lib/firebase；`lib/supabase.ts`
  新增 anon 客户端 + 服务端 `getSupabaseAdmin()`（service_role 验 token）；
  `lib/trpc.ts` createContext、`app/api/chat`、`claimOrgAction` 改为 Supabase token
  校验；`use-auth.tsx` / `trpc-client` / `ask-ai` / `forgot-password` / `claim` 换
  supabase-js auth API；`upsert-user` 从"未认证直写"加固为服务端验 token。
- `next.config.ts`：加 `output: 'standalone'` 拆除；`images.remotePatterns` 改为按
  `NEXT_PUBLIC_SUPABASE_URL` 推导（原硬编码 `*.supabase.co`）。
- 容器化：`feedbackland/Dockerfile`（node:22-alpine 多阶段，`next start` 运行，EXPOSE
  3000）+ `deploy/feedbackland/docker-compose.yml`（宿主机 8090 → 容器 3000）。
- CI/CD：release.yml deploy job 在 yue-huabu 之后追加 Feedbackland 构建与 compose
  启动；新增 GitLab CI 变量 FL_DATABASE_URL / FL_SUPABASE_URL / FL_SUPABASE_ANON_KEY /
  FL_SUPABASE_SERVICE_ROLE_KEY / FL_OPENROUTER_API_KEY（可选）。
- 侧边栏 `FEEDBACKLAND_URL` 常量指向 `http://10.37.80.25:8090`。
- 数据：在现有自建 Supabase 的 Postgres 新建独立 `feedbackland` 数据库（应用表隔离），
  storage 建 `images` 桶（匿名上传）；schema 来自 `feedbackland/db/schema.sql`。

## Impact
- Affected specs: feedbackland-deployment
- Affected code: feedbackland/（vendor + 认证改造）、deploy/feedbackland/、
  .gitlab/ci/release.yml、.gitlab-ci.yml、.dockerignore、packages/drawnix/src/constants.ts
