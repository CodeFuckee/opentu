# Tasks: add-infinite-canvas-embed

## 1. 测试先行（本仓自有代码）
- [x] 1.1 `app-shell-routing.spec.ts` 补 `/infinite`、`/infinite/`、`/infinite/canvas/1` 导航不进 app-shell 用例（先红）
- [x] 1.2 E2E `canvas-ai-embed.spec.ts` 用例表：P0 /infinite/ 直达画布壳渲染；P1 /canvas-ai 宿主页 iframe 承载 + 返回画布；P1 主应用工具箱入口存在（先红）

## 2. vendor 应用
- [x] 2.1 拷贝上游 web/ 源码（排除 node_modules/dist/锁文件）+ VERSION/CHANGELOG.md/LICENSE 至 apps/infinite-canvas/
- [x] 2.2 三处 vendor 补丁（vite 路径与 outDir / hash 路由 / antd6 styles.content）+ vendored README 记录上游版本与补丁清单
- [x] 2.3 project.json（build=run-commands vite build + VITE_BASE=/infinite/，typecheck=tsc --noEmit）；根 pnpm install 更新锁文件

## 3. 平台接线
- [x] 3.1 app-shell-routing 排除实现（转绿）
- [x] 3.2 Dockerfile COPY /infinite
- [x] 3.3 bootstrap /canvas-ai 分流 + 宿主页组件；工具箱「无限画布 ↗」入口（HoverTip）
- [x] 3.4 apps/web vite dev proxy /infinite；playwright preview webServer 增建

## 4. 验证与交付
- [x] 4.1 本地门禁：root pnpm install / nx build infinite-canvas / 全仓 typecheck / drawnix+web 全量测试 / lint / E2E 新用例 + 既有 workflow-editor 用例回归
- [x] 4.2 静态 staging 预览（模拟 busybox：web + infinite 同根）0.0.0.0 供过目（含 LAN HTTP 直访 /infinite/ 与 /canvas-ai）
- [x] 4.3 CHANGELOG 更新
- [x] 4.4 用户过目确认 → 推送 main → 监控流水线 → 汇报生产部署待手动触发
