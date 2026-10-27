# infinite-canvas（vendor 嵌入版）

上游 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)
「无限画布」AI 创作工作台的 **vendor 快照**（MIT，见 LICENSE），作为 opentu 平台的
独立子应用整包嵌入：构建产物落在主应用 dist 的 **`infinite/`** 子目录，生产镜像由
busybox httpd 同根伺服在 **`/infinite/`** 路径。入口：主应用工具箱「无限画布 ↗」
（打开 `/canvas-ai` 宿主页，AuthGate 内全屏 iframe）或直访 `/infinite/`。

- 上游版本：**v0.20.0**（快照日期 2026-10-25，取自上游仓库 `web/` 目录 + 根 VERSION/CHANGELOG.md/LICENSE）
- 上游技术栈：React 19 + Vite 7 + antd 6 + Tailwind 4 + zustand + react-router 7
  ——与主仓 React 18 栈**有意隔离**，不合并打包；依赖由根 pnpm workspace 统一安装

## 与上游的差异（vendor 补丁清单）

改代码请保持本清单同步；升级上游时逐条 rebase：

1. `vite.config.ts`
   - `VERSION` / `CHANGELOG.md` 读取路径从仓库根（`../`）改为应用目录内
     （上游二者在仓库根，vendor 时一并拷入本目录）
   - `build.outDir` 指向 `../../dist/apps/web/infinite`（`emptyOutDir`）：嵌到主
     应用 dist 的子目录，与生产镜像同根伺服、vite preview/E2E 同样可用；主应用
     `apps/web/vite.config.ts` 的 `STATIC_SCAN_EXCLUDED_DIRS` 已排除 `infinite`，
     不会进主应用 SW 预缓存
2. `src/router.tsx`：`createBrowserRouter` → `createHashRouter`。
   生产宿主 busybox httpd 无 SPA fallback，hash 路由（`/infinite/#/canvas/:id`）
   让刷新与深链在任何静态服务器下可用
3. `src/components/layout/model-script-editor.tsx`：antd 6 移除了 Modal
   `styles.content` 的类型（上游唯一的 tsc 错误）——对应样式并入既有
   `wrapClassName` 的 `.ant-modal-content` tailwind 链，视觉等价
4. `src/components/layout/app-top-nav.tsx`：logo mask 的 `/logo.svg` 改为
   `` `${import.meta.env.BASE_URL}logo.svg` ``——子路径部署下 public 资源需带前缀
5. `package.json`：`typescript` 从 `^5` 收紧为 `^5.9.0`（根锁文件钉的 5.4.5 解析
   不了 `@vitejs/plugin-react@5.2` 的 d.ts 语法）
6. `tsconfig.json`：`typeRoots` 钉在应用自身 `node_modules/@types`，`paths` 把
   `react`/`react-dom` 类型解析钉到应用内 19——monorepo 根 hoist 的
   `@types/react@18`（主应用用）会经 antd/rc-* 的 store 路径向上泄漏造成 18/19
   类型混用报错
7. `project.json`（新增）：nx 构建/typecheck 目标 + `implicitDependencies: [web]`
   （保证先建 web 再写嵌套产物）。**刻意用 run-commands 调应用自带 vite/tsc
   二进制**，不经 @nx/vite 执行器（nx 19.3 内置 vite 与 vite 7 版本耦合）；
   另显式定义 no-op `test` 目标盖掉 nx 对 package.json `bun test` 脚本的推断
   （本仓无 bun，见下节）

## 构建

```bash
pnpm exec nx build infinite-canvas     # 注入 VITE_BASE=/infinite/，产物在 dist/apps/web/infinite
pnpm exec nx run infinite-canvas:typecheck
```

本地开发（独立起服，主应用 vite dev 已配置 `/infinite` 代理到 3001）：

```bash
cd apps/infinite-canvas && VITE_BASE=/infinite/ ./node_modules/.bin/vite --port 3001
```

## 不移植的部分

- 上游 `tests/`（bun test）：本仓无 bun 运行时，不进 CI；行为由 typecheck +
  构建 + 平台 E2E smoke（`canvas-ai-embed.spec.ts`）守护
- 上游 `canvas-agent/`（本地 Agent）、`canvas-proxy/`、`plugins/`（Codex 插件）、
  `docs/`：与 Web 应用嵌入无关，不 vendor
- 遥测：`public/config.js` 保持空默认（GA4/百度统计均关闭）；`docker-entrypoint.sh`
  为上游 nginx 镜像专用，不适用本嵌入形态，未拷贝
