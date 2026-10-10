# 工作流编排上主画布(Plait 原生节点元素)技术方案

> 状态:提案待批准(未动工)
> 拍板记录:2026-10-10 grill-me——形态 A(Plait 原生节点元素)、生成图自动落节点旁、
> 数据跟画板走、M1 直接替换;二轮默认拍板:专用工作流连线、节点▶+运行全部、
> 连通图自动划分。

## Context

M1(49d04f76)已交付独立 WinBox 编排画布:React Flow 节点画布 + graph-compiler
(图→WorkflowStep[],含环检测/端口类型校验/静态内联/运行时占位符)+
workflow-engine 并行 DAG 执行(含 archive_media/insert_images)+ 28 例单测。
用户实测后确认方向调整:**编排要长在主画布上**(与创作同画布,生成图直接成为
画布内容,编排随画板持久化),WinBox 版直接替换。

主画布 = Plait 元素体系。自绘元素先例:`with-audio-node` +
`components/audio-node-element`(音频节点已以画布元素形态存在,含双击交互与
主线程组件渲染)——本 change 沿同构路线。

## 架构

```
主画布(Plait)
  ├─ workflow-node 元素(新):类型/参数/几何 即节点;卡片渲染运行态与 ▶
  ├─ workflow-connection 元素(新):source/target 节点 + 端口语义;状态染色
  └─ 现有元素(图片/文本…)不变;生成图 = 普通图片元素落节点旁
canvas-graph-adapter(纯函数,双向):
  画布 elements ──collect──▶ OrchestratorGraph ──compile──▶ WorkflowStep[]
  (复用 M1 graph-compiler 全部校验;连通图自动划分工作流)
workflow-engine:零改动(占位符解析/archive_media/insert_images 已就绪)
```

### 关键设计

1. **元素即节点**:节点参数存在元素 `params`,几何存在 `points/width/height`——
   无第二数据副本,撤销/重做/云同步/协作天然继承 Plait 体系。
2. **连线 = 专用元素**:从节点右端口拖出生成(source/target 引用节点 id + 端口);
   渲染为带方向箭头的贝塞尔线;运行时按状态染色(running 琥珀/completed 绿/failed 红)
   并叠加流动动画(css dashoffset)。类型校验复用编译器端口规则,连线生成时即时拒绝。
3. **运行粒度**:节点卡片 ▶(悬停浮现)= 跑该节点及全部上游;工具条「运行全部」=
   按连通图划分逐流运行。运行期间锁定结构编辑(增删节点/连线禁用,参数仍可改)。
4. **生成物落点**:output 步骤完成后,`insertImageFromUrl` 落在源节点右侧
   (节点右边缘 + 40px 起,纵向网格 400 间距),成为普通图片元素(可拖走/进编辑器)。
5. **交互冲突规避**:单击=选中/拖动;**双击=进入参数编辑态**(浮层面板,同画布文本
   编辑先例 `PlaitBoard.hasBeenTextEditing` 联动);节点内输入框不响应画布拖拽。
6. **M1 迁移**:WinBox 版下线;graph-storage 转为只读导入器——旧图列表
   「导入到画布」= 旧 JSON → 批量创建 workflow-node/connection 元素(含参数/几何)。

### 编译适配(零内核改动)

`collectWorkflowsFromBoard(board)`:遍历 elements 分拣 workflow-node/connection →
按连通图分组 → 每组生成 OrchestratorGraph(nodes=元素参数快照,edges=连线)→
直接调用 M1 `compileGraph`。运行态回填:引擎 stepId=nodeId(沿用 M1 约定),
事件驱动元素状态字段(Transforms.setNode 局部更新,节流)。

### 持久化与协同

节点/连线即画板 elements:本地自动保存、云同步(画板数据通道)随现有体系走,
本 change 不新增同步代码。运行历史/结果不落画布(仅生成图元素)。

## 里程碑

- **C1(MVP)**:workflow-node/connection 元素 + 派生编译 + 运行 + 自动落节点旁
  + 工具条运行全部;WinBox 下线与旧图导入
- **C2**:端口拖拽连线交互打磨、连通图分组命名、失败单点重跑、#80 DAG 只读视图
- **C3**:#79 工作流市场(画布选区导出/导入)、分支/变量(M2 遗留)

## Risks

- Plait 自定义元素插件链(渲染/命中/变换)是新领域:严格对照 with-audio-node
  先例,元素渲染走主线程 React 组件,避免深入 SW 渲染体系
- 节点编辑态与画布快捷键冲突:进入编辑态时挂起画布快捷键(文本编辑同款机制)
- 连线元素与节点删除联动(删节点级联删连线):复用 Plait 元素引用删除语义
