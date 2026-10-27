# Change: Flowgram.ai 节点编排编辑器（/workflow 全屏视图，共用编排底座）

## Why

画布原生节点编排（`workflow-node` 元素，见 add-canvas-workflow-orchestrator / add-node-workflow-orchestrator）把节点画在主画布上，交互受白板语义约束——已知痛点如节点删除静默失效（bugs 台账 2026-10-11）、无端口级连线吸附、参数编辑依赖双击弹层，难以承载复杂 DAG 的编辑体验。需要一块专业节点编辑器画布（端口连线、框选、minimap、自动布局），同时**不另起第二套图模型/执行引擎**。

选型 `@flowgram.ai/free-layout-editor`（字节开源，MIT，peer react>=16.8 与本仓 React 18.3.1 兼容，纯前端库满足 HTTP 明文部署红线）；其节点/边文档结构（`nodes[{id,type,position,data}]` + `edges[{source,sourcePort,target,targetPort}]`）与既有 `OrchestratorGraph` 几乎一一对应，转换成本低。

## What Changes

- 新增依赖 `@flowgram.ai/free-layout-editor` + `reflect-metadata`（挂在 `packages/drawnix`）
- 新增 `packages/drawnix/src/components/flowgram-workflow-editor/`：全屏编辑器（左节点面板/中画布/右参数面板 + minimap + 顶栏），节点注册由 `NODE_TYPE_SPECS` 派生（M1 同样 8 种节点），运行状态徽标订阅既有 `workflowRunService`
- 新增 `services/workflow-orchestrator/flowgram-adapter.ts`：`OrchestratorGraph` ↔ Flowgram 文档双向转换（纯函数）
- 扩展 `workflow-run-service`：新增 board-free 的 `runGraph(graph)`（复用 compileGraph → createWorkflow → engine 既有路径；无画布上下文时 `insert-canvas` 步骤标 failed 提示回画布运行）
- 新增 `/workflow` 全屏路由视图：`apps/web/src/app/bootstrap.tsx` 按 pathname 分流（复用 Auth/Theme providers），lazy 加载 drawnix 子入口 `@drawnix/drawnix/workflow-editor`（独立 chunk，主画布首屏零影响）
- 主画布入口：工具箱工作流分区加「打开编排器」；编辑器顶栏「返回画布」
- 里程碑：本 change 为 M1（编辑器 + 共底座运行闭环）；后续 M2 画布元素 ↔ 编辑器互转互导、自动布局增强

## Impact

- Affected specs: 新增 capability `workflow-node-editor`（本 change 的 specs/workflow-node-editor/spec.md）
- Affected code:
  - 新增 `packages/drawnix/src/components/flowgram-workflow-editor/`、`services/workflow-orchestrator/flowgram-adapter.ts`、`packages/drawnix/src/workflow-editor.ts`
  - 修改 `workflow-run-service.ts`（+runGraph）、`apps/web/src/app/bootstrap.tsx`（pathname 分流）、`components/toolbox-drawer/ToolboxDrawer.tsx`（入口）、`tsconfig.base.json` + `packages/drawnix/package.json`（子入口）、`package.json`（依赖）
  - 文档：CHANGELOG.md
- 不改：画布原生 `workflow-node` 元素与插件、图 schema、云同步通道（复用 `workflow` 实体）、CSP、SW 路由策略（`/workflow` 走既有 app-shell 兜底）
- 测试边界：新代码不放 `src/engine/**`（该目录有 95% 覆盖率门禁）；vitest 单测 adapter/runGraph/组件 smoke，E2E 一条全链路
