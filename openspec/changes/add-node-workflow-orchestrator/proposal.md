# Change: 节点式工作流编排系统(工作流画布 + DAG 执行 + 模板市场)

## Why

功能计划表 #71(节点式生图流水线编辑器)、#79(工作流市场)、#80(多任务编排视图)三个条目指向同一个能力域——**可视化工流编排**,2026-10-09 经用户确认整合升格为 **P0 专项「工作流编排系统」**。

现状:任务队列 + 分步创作向导已覆盖线性生成场景,但分支、多输入组合、一次编排反复复用这类**非线性工作流**只能手工逐步操作;`services/workflow-engine` 执行内核已 DAG 就绪(步骤 `dependsOn` 依赖调度、MCP 工具调用、批量、abort、事件流、IndexedDB 持久化、云同步 `workflow` 通道),唯独缺 ComfyUI/Dify 式的**节点画布编排 UI** 与「图 → 步骤」编译层。

## What Changes

- 新增依赖 `@xyflow/react`(React Flow 12,MIT):节点画布编辑器(连线/拖拽/缩放/自动布局),npm 随 lockfile 内网分发,无运行时外网依赖,零 CSP/SW 改动
- 新增 `packages/drawnix/src/components/workflow-orchestrator/`:节点画布(WinBox 工具窗承载)、节点组件(输入/生图/输出三类 8 种,M1)、参数面板、运行态染色
- 新增 `packages/drawnix/src/services/workflow-orchestrator/`:节点注册表、图 → `WorkflowStep[]` 编译器(拓扑校验 + 端口数据绑定)、图 JSON 的存取(版本化,复用 `workflow` 云同步通道)
- 扩展 `services/workflow-engine`:接受编译产物并行执行依赖就绪步骤(M1 允许按层串行)、步骤状态事件补节点 id 映射
- 工具箱新增「工作流编排」内置工具(复用 tools/registry 内部组件通道)
- 里程碑:**M1** 生图链路最小闭环(本 change);**M2** 分支/变量/批量与 #80 任务 DAG 视图;**M3** #79 模板导入导出与市场分发

## Impact

- Affected specs: 新增 capability `workflow-orchestrator`(本 change 的 specs/workflow-orchestrator/spec.md)
- Affected code:
  - 新增 `packages/drawnix/src/components/workflow-orchestrator/`、`packages/drawnix/src/services/workflow-orchestrator/`
  - 修改 `packages/drawnix/src/services/workflow-engine/`(并行调度、事件补映射)、`src/tools/built-in-manifests` + `tools/registry`(新工具注册)、`package.json`(+`@xyflow/react`)
  - 文档:`docs/new-feature-plan-100.md`(#71/#79/#80 专项标注)、CHANGELOG.md
- 不改数据库 schema、不改 CSP、不改 SW;云同步复用既有 `workflow` 通道(图 JSON 作为版本化 content)
- 风险边界:生成任务仍走既有任务队列/服务端,编排器只做调度与数据传递,不新增算力面
