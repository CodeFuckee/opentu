# Change: 工作流编排上主画布——Plait 原生节点元素(grill-me 四项拍板)

## Why

M1 交付的工作流编排是独立 WinBox 画布(React Flow),与主画布割裂:生成结果要手动插入、
画布上已有的图片不能直接当输入、编排图不随画板走。用户确认(2026-10-10 grill-me):
**在现有主画布上原生实现编排**——节点成为画布元素,编排与创作同一张画布完成。

四项拍板:**A. Plait 原生节点元素**(最高形态);**生成图自动落节点旁**;
**编排数据跟画板走**;**M1 WinBox 版直接替换**(引擎/编译器层保留)。
第二轮未答复项按推荐默认拍板:专用工作流连线、节点 ▶+运行全部、连通图自动划分。

## What Changes

- 新增 Plait 插件 `with-workflow-node`:新元素类型 `workflow-node`
  (参照 with-audio-node 先例),节点=画布元素(可选中/拖动/框选/对齐/撤销),
  渲染工作流卡片(类型头/参数内联/运行态/▶ 按钮);双击进入参数编辑态
- 新增工作流连线:端口拖出生成,运行态流动动画 + 状态染色;数据流语义独立于普通箭头
- 图派生:从画布元素(workflow-node + 工作流连线)实时派生 OrchestratorGraph,
  **复用 M1 graph-compiler 与 workflow-engine 全部内核**(编译校验/占位符解析/
  archive_media/insert_images 步骤不变)
- 运行:节点 ▶(跑该节点及上游)+ 工具条「运行全部」(连通图自动划分工作流);
  生成图自动落节点旁(网格排布,普通图片元素可再编辑)
- 持久化:节点/连线即画板元素,随画板本地与云端同步天然工作;一张画布可共存多个
  连通工作流
- 下线 M1 WinBox 版(组件与路由移除);提供旧图(IndexedDB)一次性「导入到画布」;
  graph-compiler/graph-storage 的测试内核保留,storage 转为导入读取器
- M2 预留:分支/变量/批量、#80 任务 DAG 视图路线不变

## Impact

- Affected specs: `workflow-orchestrator` capability 修订(承载面从 WinBox 改为主画布,
  执行/编译/持久化语义继承)
- Affected code:
  - 新增 `packages/drawnix/src/plugins/with-workflow-node.ts`、
    `components/workflow-node-element/`(元素渲染)、
    `services/workflow-orchestrator/canvas-graph-adapter.ts`(元素↔图适配)
  - 修改 Plait 插件注册(drawnix.tsx)、工具条(运行全部入口)、
    `services/workflow-orchestrator/graph-storage.ts`(转导入读取器)
  - 移除 `components/workflow-orchestrator/`(React Flow 壳)与 `@xyflow/react` 依赖
  - 保留:`graph-compiler.ts`(+12 例单测)、引擎 resolveStepArgs/archive_media、
    sw-capabilities insert_images
- 风险:Plait 自定义元素是新领域(参照 audio-node 先例控制范围);
  节点内输入与画布拖拽的交互冲突(双击进编辑态规避);
  连线类型校验依赖端口 schema(复用编译器规则)
