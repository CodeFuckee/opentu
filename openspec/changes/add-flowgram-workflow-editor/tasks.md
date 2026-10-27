# Tasks: add-flowgram-workflow-editor

## 1. 依赖与 spike
- [x] 1.1 `pnpm add @flowgram.ai/free-layout-editor reflect-metadata --filter @aitu/drawnix`
- [x] 1.2 spike：最小 createEditor 用例过 vite 编译（reflect-metadata/inversify 兼容），确认 Provider/createEditor/节点注册 API（以装包 d.ts + 官方 demo 为准）

## 2. 数据转换层
- [x] 2.1 `services/workflow-orchestrator/flowgram-adapter.ts`：toFlowgramDocument / fromFlowgramDocument 纯函数双向转换（端口 id 原文透传、geometry↔position、坏数据防御）
- [x] 2.2 `flowgram-adapter.test.ts`：roundtrip / 缺字段 / 未知类型

## 3. 运行服务扩展
- [x] 3.1 `workflow-run-service.runGraph(graph)`：board-free 编译执行，复用既有状态广播；无 board 时 insert-canvas 步骤标 failed
- [x] 3.2 runGraph 单测（mock engine）

## 4. 编辑器视图
- [x] 4.1 `components/flowgram-workflow-editor/`：画布 + 节点注册（NODE_TYPE_SPECS 派生）+ 端口渲染 + 参数面板（复用既有 node-registry 表单）
- [x] 4.2 左侧节点面板 / minimap / 顶栏（图名、保存、运行/停止、返回画布）+ 运行状态徽标（订阅 run service）
- [x] 4.3 图管理：graph-storage 列表/新建/保存/删除；URL `?graph=<id>` 直开
- [x] 4.4 样式 scss（Md3 dark/light 双主题）
- [x] 4.5 子入口 `src/workflow-editor.ts` + tsconfig paths + drawnix exports；编辑器组件 smoke 测试

## 5. 应用接线
- [x] 5.1 `bootstrap.tsx` pathname 分流 `/workflow`（lazy + 同套 providers）
- [x] 5.2 工具箱工作流分区「打开编排器」入口；编辑器「返回画布」
- [x] 5.3 验证 `/workflow` 刷新直达（_redirects + SW app-shell 路由），补白名单（如有）

## 6. 测试与交付
- [x] 6.1 全量 `pnpm test` + build 通过（新代码不进 src/engine/**）
- [x] 6.2 E2E：/workflow 打开 → 加 2 节点 → 连线 → 保存 → 刷新仍在 → 返回画布
- [x] 6.3 CHANGELOG.md 更新
- [x] 6.4 本地 dev server --host 0.0.0.0 用户过目（含 LAN HTTP 直访 /workflow）
- [x] 6.5 推送 main → 监控流水线 test 全绿 → 汇报生产部署待用户手动触发
