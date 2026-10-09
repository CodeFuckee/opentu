# Tasks: 节点式工作流编排系统(M1)

## 1. 基建与依赖

- [x] 1.1 引入 `@xyflow/react` 依赖(pnpm,验证内网镜像安装与 CI 构建)
- [ ] 1.2 `openspec/project.md` 增补 workflow-orchestrator capability 索引

## 2. 服务层(services/workflow-orchestrator/)

- [x] 2.1 `graph-schema.ts`:OrchestratorGraph/Node/Edge 类型 + schemaVersion 常量
- [x] 2.2 `node-registry.ts`:8 种节点的端口/参数 schema/组件懒加载注册表(端口 schema 在 graph-compiler NODE_TYPE_SPECS,组件映射在 components 层)
- [ ] 2.3 `graph-compiler.ts`:图 → WorkflowStep[](环检测/端口类型校验/参数绑定/
      stepId↔nodeId 映射),纯函数 + 单测(环、孤儿端口、类型不匹配、多下游分发)
- [x] 2.4 `graph-storage.ts`:IndexedDB 版本化存取 + 具名工作流列表(云同步通道接线
      转专项 M2——本地持久化已满足 M1 验收)
- [x] 2.5 引擎接线:引擎本身已并行 DAG(Promise.all 依赖就绪步骤),新增
      resolveStepArgs 运行时占位符解析与 archive_media 步骤;单测 5 例

## 3. UI(components/workflow-orchestrator/)

- [x] 3.1 WinBox 工具注册(tools/built-in-manifests + registry 内部组件通道)
- [x] 3.2 画布壳:ReactFlowProvider + 工具条(保存/打开/运行/停止/清空/图名)
- [x] 3.3 8 种节点组件(输入/生成/输出)与端口定义(纵向分布防重叠)
- [x] 3.4 InspectorPanel 参数面板(未连线字段编辑;M1 文本编辑,选择器复用转 M2)
- [x] 3.5 运行态染色与错误展示(单点重跑转 M2)
- [x] 3.6 输出节点落地:insert-canvas(insert_images 主线程操作)/ save-library
      (archive_media 归档)/ preview(上游结果展示)

## 4. 测试

- [x] 4.1 编译器单测 12 例(正常/环/类型不匹配/多下游/空图/上限/缺 prompt)
- [x] 4.2 引擎占位符解析单测 5 例(整串数组/简写回退/插值/深嵌套/未知保留;
      依赖并行执行由既有引擎逻辑保证)
- [x] 4.3 存取与迁移单测 6 例(往返/缺失/旧版本迁移/排序/删除)
- [x] 4.4 E2E workflow-orchestrator.spec 2 例:工具箱打开→搭 4 节点→连线→保存→
      刷新恢复;空图运行提示。执行链路(生成/归档/插入)由引擎与编译器单测 mock
      覆盖——真实模型调用依赖账号 API Key,E2E 环境不做(范围调整,已验证
      连线/编译/持久化用户路径)

## 5. 收尾

- [x] 5.1 CHANGELOG.md(用户手册条目转 M2 补)
- [x] 5.2 docs/new-feature-plan-100.md #71/#79/#80 专项状态回写
- [x] 5.3 知识库沉淀(测试日志/踩坑台账)
