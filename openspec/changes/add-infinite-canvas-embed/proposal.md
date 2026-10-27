# Change: 嵌入 infinite-canvas（独立构建，挂平台同域 /infinite/ 子路径）

## Why

用户确认方向：把 basketikun/infinite-canvas（无限画布 AI 创作工作台，MIT，v0.20.0）
**整个嵌进平台**——画布编排 + AI 生图/参考图编辑/对话助手/提示词库/素材沉淀一体化界面。
该应用是 React 19 + Vite 7 + antd 6 + Tailwind 4 技术栈，与本仓 React 18 + TDesign/MUI
无法合并打包（双 React 共存不可行），唯一可行形态是**独立构建、同域子路径伺服、平台内入口**。

## What Changes

- 新增 `apps/infinite-canvas/`：vendor 上游 `web/` 全部源码（v0.20.0 快照）+ VERSION +
  CHANGELOG.md + LICENSE（MIT 归属保留，遵循上游「二次开发保留原作者信息与前端页面标识」）
- 最小 vendor 补丁（vendored-app 内，逐条记录在 apps/infinite-canvas/README.md）：
  1. vite.config.ts：VERSION/CHANGELOG 路径改指应用内；outDir → `../../dist/apps/infinite-canvas`
  2. 路由 createBrowserRouter → createHashRouter（busybox httpd 无 SPA fallback，
     hash 路由让刷新/深链在任何静态服务器下可用）
  3. model-script-editor.tsx：antd 6 移除 Modal styles.content 类型——样式迁移到
     既有 wrapClassName tailwind 链（视觉等价），修掉上游唯一的 typecheck 错误
- 平台接线：
  - `apps/web/src/sw/app-shell-routing.ts`：`/infinite` 前缀排除出 app-shell 策略
    （否则 SW 用主应用壳应答 /infinite/ 导航，画布永远打不开）；先补单测再实现
  - Dockerfile：新增 `COPY dist/apps/infinite-canvas/ → /home/static/infinite`
  - `apps/web` vite dev server 增加 `/infinite` 代理（开发态指向画布独立 dev server）
  - 主应用工具箱新增「无限画布 ↗」入口；新增 `/canvas-ai` 主应用路由（AuthGate 内，
    全屏 iframe 承载 /infinite/ + 「← 画布」返回），bootstrap pathname 分流复用 /workflow 模式
  - E2E playwright preview webServer 增建 infinite-canvas
- 构建注册：pnpm workspace 纳管（apps/* 已覆盖）；project.json 用 run-commands 调
  应用自带 vite/tsc（不经 @nx/vite 执行器，规避 nx 19.3 与 vite 7 的版本耦合）；
  构建期注入 `VITE_BASE=/infinite/`（上游已内建支持）

## Impact

- Affected specs: 新增 capability `canvas-ai-workbench`
- Affected code:
  - 新增 `apps/infinite-canvas/**`（vendor 源码 + project.json + README）
  - 修改 `apps/web/src/sw/app-shell-routing.ts`（+spec）、`apps/web/src/app/bootstrap.tsx`、
    `apps/web/vite.config.ts`（dev proxy）、`ToolboxDrawer.tsx`（入口）、`Dockerfile`、
    `apps/web-e2e/playwright.config.ts`（preview webServer）
- 不改：主应用编排底座/Flowgram 编辑器/图 schema；infinite-canvas 自身功能逻辑
  （仅上述 3 处 vendor 补丁）
- 测试边界：SW 排除单测（先行）+ E2E smoke（/infinite/ 直达、/canvas-ai 宿主页、
  画布壳渲染）；上游 bun 测试不移植（上游 bun 运行时本仓无，逻辑由 typecheck +
  build + E2E smoke 守护）；vendored 应用不接 eslint/vitest 目标（CI run-many 自动跳过）
- 部署：零基础设施变更——仍由 busybox httpd 静态伺服，/infinite/ 随镜像分发；
  遥测默认关闭（config.js 空默认）
