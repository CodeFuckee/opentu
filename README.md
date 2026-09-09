<div align="center">
  <h1>Yue画布 (Yue画布.ai)</h1>
  <h3>开图 · 以画布为核心的 AI 应用平台</h3>
  <p>连接多模型生成、工具、素材与知识流，让 AI 任务在同一工作区持续执行。</p>
  <p>
    <a href="https://github.com/ljquan/aitu/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
    <a href="https://opentu.ai"><img src="https://img.shields.io/badge/demo-online-brightgreen.svg" alt="Demo"></a>
  </p>
  <p>
    <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fljquan%2Faitu&project-name=aitu&repository-name=aitu"><img src="https://vercel.com/button" alt="Deploy with Vercel"></a>
    <a href="https://app.netlify.com/start/deploy?repository=https://github.com/ljquan/aitu"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify"></a>
  </p>
</div>

[English README](./README_en.md)

## 在线体验

- 正式站点：[Yue画布.ai](https://opentu.ai)
- 预览实例：[pr.Yue画布.ai](https://pr.opentu.ai)

## 产品展示

| 拆分图片 | 流程图 | 思维导图 |
| --- | --- | --- |
| ![](./apps/web/public/product_showcase/九宫格拆图.gif) | ![](./apps/web/public/product_showcase/流程图.gif) | ![](./apps/web/public/product_showcase/思维导图.gif) |
| 语义理解 - 拆分图片 | 语义理解 - 流程图 | 语义理解 - 思维导图 |

## 平台能力

- **AI 生成与模型路由**：统一调度图片、视频、音频、文本与 Agent 流程。
- **画布工作区**：承载 AI 任务、素材、Frame、工具窗口与知识库内容。
- **任务与素材管理**：通过任务队列、素材库、统一缓存和历史记录复用生成结果。
- **云端同步（Supabase）**：登录后自动把画板、任务、提示词、工作流、知识库、聊天、音频、
  角色、素材、设置同步到私有云端，换浏览器/设备登录同一账号即可看到之前的记录。
- **工具箱与扩展**：支持内部 React 工具、iframe 工具、Skill/Agent 和插件化运行时。
- **PPT 与内容工作流**：支持 Frame 幻灯片、PPT 导出、Markdown/Mermaid 转换和多媒体编辑。
- **用户反馈（Feedbackland）**：侧边栏一键直达自部署的 Feedbackland 反馈平台（跳转地址
  配置于 `FEEDBACKLAND_URL` 常量）。

## 本地开发

### 环境要求

- Node.js 20+
- pnpm 10.21.0（推荐通过 Corepack 启用）

### 安装与启动

```bash
corepack enable pnpm
pnpm install
pnpm start
```

启动后访问 `http://localhost:7200`。

如需本地启动前端、后端直接连**生产环境 Supabase**（登录/云端同步走生产数据），
使用：

```bash
pnpm start:prod-supabase
```

该脚本通过进程环境变量注入 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
（优先级高于 `apps/web/.env`，默认值取自 `apps/web/.env.example`，不修改本地
配置文件），启动前自动探测生产 Supabase 可达性，dev server 就绪后自动打开
浏览器、意外崩溃时自动重启（连续 5 次失败后放弃）；支持 `--url` / `--key` /
`--no-open` 参数，详见
[`scripts/start-local-prod-supabase.mjs`](./scripts/start-local-prod-supabase.mjs)。

### 常用命令

```bash
pnpm start             # 启动 Web 开发服务
pnpm build:web         # 构建 Web 应用
pnpm build             # 构建工作区
pnpm check             # typecheck + lint
pnpm test              # 运行单元测试
pnpm e2e:smoke         # 运行冒烟测试
pnpm e2e:manual-nav    # 用户手册侧边栏导航 E2E（开发环境；生产环境用 e2e:manual-nav:prod）
pnpm check:cycles      # 检查循环依赖
pnpm manual:build      # 生成用户手册（web 构建时自动执行，产出至 apps/web/public/user-manual）
```

## 部署

项目保留多条部署链路：

- Vercel / Netlify：使用上方一键部署按钮或仓库配置。
- Docker：使用仓库根目录的 `Dockerfile` 构建静态站点镜像。
- Hybrid CDN + 自托管：见 [NPM CDN 部署](./docs/NPM_CDN_DEPLOY.md) 与 [CDN 部署](./docs/CDN_DEPLOYMENT.md)。

### Feedbackland 自托管部署（随发布流水线一并部署）

- 反馈平台 Feedbackland（Next.js 16）已 vendor 到 [`feedbackland/`](./feedbackland/)，
  认证改造为复用现有自建 Supabase 的 Auth/存储/Postgres（独立 `feedbackland` 数据库）。
- 容器化：`feedbackland/Dockerfile`（多阶段，`next start` 运行，EXPOSE 3000）+
  [`deploy/feedbackland/docker-compose.yml`](./deploy/feedbackland/docker-compose.yml)
  （宿主机 `8090` → 容器 `3000`）。
- 发布流水线（手动 web/api 触发）的 deploy 阶段会与 opentu 一并构建并启动 Feedbackland。
  部署前需在 GitLab CI/CD Variables 配置（`FL_` 前缀，缺少任一必填变量时构建会失败）：
  - `FL_DATABASE_URL`：Feedbackland 独立数据库连接串（如
    `postgres://postgres:<密码>@10.37.80.25:5432/feedbackland`）
  - `FL_SUPABASE_URL`：自建 Supabase 网关地址（如 `http://10.37.80.25:8021`）
  - `FL_SUPABASE_ANON_KEY`：anon key（公钥）
  - `FL_SUPABASE_SERVICE_ROLE_KEY`：服务端 service_role 密钥（机密）
  - `FL_OPENROUTER_API_KEY`（可选）：AI 洞察功能
- 侧边栏 Feedbackland 按钮跳转地址为 `FEEDBACKLAND_URL` 常量
  （`packages/drawnix/src/constants.ts`），当前指向 `http://10.37.80.25:8090`。
- 首次部署前需在现有 Supabase 实例上做一次性数据准备：建 `feedbackland` 数据库 →
  执行 [`feedbackland/db/schema.sql`](./feedbackland/db/schema.sql) → 建 storage
  `images` 桶；并在 Supabase Auth 设置中关闭"邮箱确认"（Confirm email），否则注册后
  不会自动登录。

## 仓库结构

```text
aitu/
├── apps/
│   ├── web/                 # Yue画布 Web 应用与 Service Worker
│   └── web-e2e/             # Playwright E2E 与手册生成脚本
├── packages/
│   ├── drawnix/             # 画布工作区核心库
│   ├── react-board/         # Plait React 画布适配层
│   ├── react-text/          # 文本渲染组件
│   └── utils/               # 共享工具与工作流解析
├── docs/                    # 当前开发文档入口
├── openspec/                # 需求规格与变更提案
└── scripts/                 # 构建、发布、手册与部署脚本
```

## 文档入口

- [开发文档索引](./docs/README.md)
- [云端同步说明](./docs/cloud-sync.md)
- [贡献指南](./CONTRIBUTING.md)
- [OpenSpec 说明](./openspec/AGENTS.md)

## License

MIT
