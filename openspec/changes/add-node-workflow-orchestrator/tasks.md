# Tasks: 节点式工作流编排系统(M1)

## 1. 基建与依赖

- [ ] 1.1 引入 `@xyflow/react` 依赖(pnpm,验证内网镜像安装与 CI 构建)
- [ ] 1.2 `openspec/project.md` 增补 workflow-orchestrator capability 索引

## 2. 服务层(services/workflow-orchestrator/)

- [ ] 2.1 `graph-schema.ts`:OrchestratorGraph/Node/Edge 类型 + schemaVersion 常量
- [ ] 2.2 `node-registry.ts`:8 种节点的端口/参数 schema/组件懒加载注册表
- [ ] 2.3 `graph-compiler.ts`:图 → WorkflowStep[](环检测/端口类型校验/参数绑定/
      stepId↔nodeId 映射),纯函数 + 单测(环、孤儿端口、类型不匹配、多下游分发)
- [ ] 2.4 `graph-storage.ts`:IndexedDB 版本化存取 + 具名工作流列表 + 云同步通道接线
      (collector/apply-remote 扩展 workflow-graph 类型)
- [ ] 2.5 引擎接线:`findExecutableSteps` 并发派发改造(或依赖层串行先行)+
      WorkflowEvent 补 nodeId;引擎单测补依赖图用例

## 3. UI(components/workflow-orchestrator/)

- [ ] 3.1 WinBox 工具注册(tools/built-in-manifests + registry 内部组件通道)
- [ ] 3.2 画布壳:ReactFlowProvider + 工具条(保存/打开/运行/停止/清空/图名)
- [ ] 3.3 8 种节点组件(输入/生成/输出)与端口定义
- [ ] 3.4 InspectorPanel 参数面板(未连线字段编辑;模型/素材库选择器复用)
- [ ] 3.5 运行态染色与错误浮层;失败节点单点重跑(含下游)
- [ ] 3.6 输出节点落地:insert-canvas(网格排布)/ save-library(归档链路)/ preview

## 4. 测试

- [ ] 4.1 编译器单测(正常/环/类型不匹配/查询串边界/空图/大图上限)
- [ ] 4.2 引擎依赖执行单测(多下游/失败中断/重跑)
- [ ] 4.3 存取与迁移单测(schemaVersion 升级)
- [ ] 4.4 E2E:工具箱打开→搭图→运行→素材库+画布落地→保存刷新恢复
      (服务 route mock,不依赖真实模型;参照 smart-cutout.spec 模式)

## 5. 收尾

- [ ] 5.1 CHANGELOG.md + 用户手册(工具说明)
- [ ] 5.2 docs/new-feature-plan-100.md #71/#79/#80 里程碑状态回写
- [ ] 5.3 知识库沉淀(测试日志/踩坑台账)
