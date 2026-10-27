# Design: add-flowgram-workflow-editor

## Context

- 既有编排底座（M1 已落地）：`services/workflow-orchestrator/`——`graph-schema.ts`（OrchestratorGraph：nodes/edges/ports、schemaVersion 迁移、64 节点上限）、`graph-compiler.ts`（`NODE_TYPE_SPECS` 端口注册 + 编译校验）、`graph-storage.ts`（IndexedDB KV `workflow_graph:*`）、`workflow-run-service.ts`（画布元素级 runAll、状态 snapshot 广播）、`canvas-graph-adapter.ts`（画布元素 ↔ 图）。
- `apps/web` 无路由（query 参数 + pushState），全屏视图分流点在 `bootstrap.tsx:775-791`；SPA fallback（`_redirects`）与 SW app-shell 路由已覆盖 path 直达。
- React 18.3.1 单实例（vite/vitest 均 dedupe）；`.npmrc` legacy-peer-deps。

## Goals / Non-Goals

- Goals: 专业节点编辑体验（端口连线/框选/minimap）；图数据与执行与画布编排完全同底座；主画布首屏零体积增量；存量图直接可开。
- Non-Goals: 不替换画布原生 workflow-node 元素；不做模板市场/变量系统（M2+）；不引入 semi-ui（面板用既有 UI 栈 + 自绘 scss）；不做服务端执行。

## Decisions

- **Decision 1：Flowgram 只做编辑器层，数据/执行共用底座。**
  转换器 `flowgram-adapter.ts` 做纯函数双向映射；端口 id 沿用 `inputs:xxx`/`outputs:xxx` 原文，不翻译，避免第三套端口命名。
  - Alternative: Flowgram 自带文档模型直接持久化 → 会分叉图模型，弃。
- **Decision 2：`/workflow` 在 bootstrap 按 pathname 分流，复用同一套 providers**（ErrorBoundary > Md3ThemeProvider > AuthProvider > AuthGate），编辑器代码走 drawnix 子入口 `@drawnix/drawnix/workflow-editor`（`import 'reflect-metadata'` 最先），动态 import 自动独立 chunk。
  - Alternative: WinBox 浮窗 → 编辑空间受限（用户已选全屏）；react-router → 单页应用引入路由栈超出需要，弃。
- **Decision 3：运行入口扩展为 board-free 的 `runGraph(graph)`**，与画布 runAll 共用 compile→createWorkflow→engine 与状态广播代码路径；`insert-canvas` 等需画布的落地节点在无 board 时该步骤标 failed（中文提示「回画布后运行」），不阻断其余节点。
  - Alternative: 编辑器内不提供运行 → 功能残缺；把画布引用跨视图共享 → 脆弱耦合，弃。
- **Decision 4：节点 UI 注册由 `NODE_TYPE_SPECS` 单一事实源派生**（端口数量/类型/直通标记），参数表单优先复用 `components/workflow-orchestrator/node-registry` 既有面板组件，避免两套表单漂移。

## Risks / Trade-offs

- Flowgram 文档外网抓取不稳 → 装包后以 d.ts + 官方 demo 源码为准；spike 前置（vite 编译 + createEditor 最小用例），不通过则改 `@flowgram.ai/editor` 子包组合并回报。
- inversify/reflect-metadata 与 vite 预打包兼容性 → spike 验证；必要时 `optimizeDeps.exclude`。
- 编辑器依赖体积较大 → 仅 `/workflow` 视图加载，主画布不受影响；不进 IDLE_PREFETCH_GROUPS。

## Migration Plan

纯新增 + 两处小接线（bootstrap 分流、工具箱入口按钮），无数据迁移；存量 `workflow_graph:*` 图直接可打开（schemaVersion 机制不动）。

## Open Questions

- 无（集成形态与架构关系已经用户确认：全屏 /workflow + 共用底座）。
