# 节点式工作流编排系统 技术方案

> 状态:方案待评审(M1 未动工)
> 拍板记录:2026-10-09 grill-me 四项确认——画布选型 **React Flow(@xyflow/react)**;
> M1 节点范围 **生图链路最小闭环**;入口 **工具箱 WinBox**;优先级 **P0,M1 立即启动**。

## Context

- 用户诉求:像 ComfyUI/Dify 那样,把"提示词 → 生图 → 落库/上画布"这类流程在画布上
  用节点连线编排,一次搭建反复复用;对应计划表 #71(编排画布)/#79(市场)/#80(DAG 视图)。
- 现有底座(2026-10-09 代码盘点):
  - `services/workflow-engine/engine.ts`(663 行):`Workflow`/`WorkflowStep{mcp, args,
    dependsOn, status, batch*}`,`findExecutableSteps` 按 `dependsOn` 调度依赖就绪步骤,
    经 media-executor/media-generation 发任务并轮询,abort/事件流(`events$`)/IndexedDB
    持久化(workflow-storage-writer)齐全——**DAG 就绪,缺的是图来源**。
  - 步骤以 **MCP 工具名**(`step.mcp`)调用,`pending_main_thread` 状态支持需 Canvas/DOM
    的工具——节点执行器可直接复用 MCP 工具注册表。
  - 云同步已有 `workflow` 通道(collector.collectWorkflows → user_sync_data;
    apply-remote → workflowStorageWriter),编排图可搭车。
  - `engine/workflow/` 是创作向导(漫画/MV)的分步流,与本专项**互不影响**。
- 缺口:节点画布 UI、节点类型系统、图 → steps 编译层、运行态可视化。

## Goals / Non-Goals

**Goals(M1,本 change)**
- 工具箱点「工作流编排」开 WinBox 画布:拖入节点、连线、配参数、保存/打开多张图
- 三类 8 种节点(见下)覆盖"提示词/参考图 → 生图 → 落地"最小闭环
- 运行:拓扑执行 + 节点运行态染色 + 失败节点标红可单点重跑
- 图 JSON 版本化持久化(IndexedDB)+ 云同步跨设备
- 全程内网 HTTP 可用(无 secure-context 依赖;npm 包随 lockfile 分发)

**Non-Goals(M1 明确不做)**
- 分支条件/循环/数组映射/表达式引擎(M2)
- 任务队列 DAG 只读视图 #80(M2,复用 React Flow)
- 模板导入导出与市场分发 #79(M3)
- 自定义节点 SDK/插件化(M3 后评估)、SW/Worker 执行(生成走服务端,主线程轮询够用)

## 选型与理由

### D1 画布:@xyflow/react(React Flow 12)

- React 生态节点编辑器事实标准(Flowise/Langflow 同款),MIT;连线/拖拽/框选/缩放/
  mini-map/dagre 自动布局开箱即用,自研成本集中在节点组件本身
- 纯前端库:随 lockfile + pnpm 镜像内网分发;产物同源打包,**零 CSP/SW 改动**
- 不选 Plait 扩展:Plait 语义是白板元素(思维导图/连接线),端口/类型校验/DAG 布局
  都要逆着库做;不选自研 SVG:连线碰撞/自动布局/框选自研周期不可控

### D2 执行:扩展 workflow-engine,不另起引擎

- 编译器把节点图编译为 `WorkflowStep[]`(`mcp` + `args` + `dependsOn`),引擎零概念
  变化即可跑;参数绑定在编译期解析(源节点输出 → 目标节点 args 字段),M1 不做
  运行时表达式
- 调度:引擎主循环改为"每轮取 `findExecutableSteps` 并发派发、等任一完成再续"——
  M1 可先按依赖层串行(正确性优先),并发派发作为同 change 内的独立 task
- 节点状态回填:`WorkflowEvent` 带 stepId,编译器维护 stepId → nodeId 映射,UI 订阅染色

### D3 节点模型

```ts
interface OrchestratorNode {
  id: string;                       // nodeId(即前端节点 id)
  type: NodeTypeName;               // 见下表
  params: Record<string, unknown>;  // 未连线的字段用面板值
  geometry: { x: number; y: number };
}
interface OrchestratorEdge {
  id: string;
  source: string; sourcePort: string;   // 如 img-gen.outputs.images
  target: string; targetPort: string;   // 如 save-library.inputs.images
}
interface OrchestratorGraph {
  schemaVersion: number;            // 图 JSON 版本化,迁移函数逐版升级
  nodes: OrchestratorNode[];
  edges: OrchestratorEdge[];
}
```

### D4 M1 节点类型(3 类 8 种)

| 类 | 节点 | 输出端口 | 说明 |
|---|---|---|---|
| 输入 | prompt(提示词) | `text` | 多行文本 + 历史提示词选择(复用 prompt-history) |
| 输入 | reference-image(参考图) | `image` | 本地上传/素材库选择/粘贴(复用素材库选择器) |
| 输入 | model-picker(模型与参数) | `model` | 模型/尺寸/张数(复用 model-catalog 与设置存储) |
| 生成 | image-generation(文生图) | `images` | prompt + model + 可选参考图;走 media-generation 现有任务链 |
| 生成 | image-variation(基于图生成/编辑) | `images` | 参考图 + prompt(指令式编辑,同 AI 输入条链路) |
| 输出 | insert-canvas(插入画布) | — | 走 ai-outputs 直链插入,网格排布 |
| 输出 | save-library(存素材库) | — | 复用素材库入库归档链路 |
| 输出 | preview(预览) | — | 节点内轮播预览,不落地 |

编译映射示例:`prompt.text → image-generation.args.prompt`;
`model-picker.model → image-generation.args.model`;
`image-generation.images → save-library.inputs.images`(每图一个归档任务,batch 语义复用)。

## 架构

```
WinBox(workflow-orchestrator 工具)
  └─ ReactFlowProvider
       ├─ OrchestratorCanvas(@xyflow/react;节点组件=注册表驱动)
       ├─ InspectorPanel(选中节点参数;未连线字段)
       ├─ Toolbar(保存/打开/清空/运行/停止;图名)
       └─ RunOverlay(运行态:节点描边色 + 步骤耗时 + 错误浮层)
services/workflow-orchestrator/
  ├─ node-registry.ts      节点类型注册表(端口/参数 schema/组件懒加载)
  ├─ graph-compiler.ts     OrchestratorGraph → WorkflowStep[](拓扑校验:
  │                        环检测/孤儿端口/类型不匹配;stepId↔nodeId 映射)
  ├─ graph-storage.ts      图 JSON 版本化存取(IndexedDB;复用 workflow 云同步通道)
  └─ graph-schema.ts       schemaVersion 常量与迁移函数
services/workflow-engine/(改)
  └─ engine.ts             依赖层并发派发(M1 亦可层内串行);事件补 nodeId
```

- 环检测在编译期拒绝(报错定位到边);运行中改图提示"运行中锁定"
- 生成任务照旧进任务队列(服务端执行,前端轮询),编排器不做新执行面
- 大图保护:M1 节点数上限(如 64)与单节点张数上限,防误操作拖垮主线程

## 里程碑

- **M1(本 change)**:上述最小闭环。验收:官方库选 1 张参考图 + 提示词 → 生图 4 张 →
  自动存素材库 + 插画布;保存 → 刷新 → 打开还在;换设备登录图同步。
- **M2**:分支条件节点、数组映射(批量对每张图再编辑)、参数快照(#76 合流)、
  失败断点续跑、**#80** 任务队列 DAG 只读视图。
- **M3**:**#79** 图 JSON 导出/导入文件、发布到模板中心(新模板类型)、按模板一键实例化。

## Risks / Trade-offs

- React Flow 与 WinBox 滚轮/拖拽事件冲突:画布容器 `preventScroll` + WinBox 标题栏
  拖动隔离(素材库已有同款处理经验)
- 主线程轮询多个长任务:现状任务队列同款模型,服务端执行本地仅轮询,M1 接受;
  M2 若卡顿再评估 Worker 化
- 图 schema 演进:schemaVersion + 迁移函数从第一天强制,避免存量大图报废
- 内网依赖:`@xyflow/react` 入 lockfile 后 CI/pnpm 镜像分发,无需运行时外网

## Open Questions

- 节点画布是否需要支持在主画布上直接锚定运行结果(生成即插到指定位置)——M2 与
  #72 画布 Agent 一并评估
