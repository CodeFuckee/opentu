# Change: MD3 主题系统与组件迁移规范

## ADDED Requirements

### Requirement: MD3 主题令牌体系统一全局视觉

系统 SHALL 提供 MD3（Material Design 3）主题：以品牌橙 #F39C12 为种子色生成全套
color roles，定义 typography/shape/elevation 令牌，支持 light/dark 双模式并对接既有
主题切换；主题令牌 SHALL 回写既有 `--color-*` CSS 变量使存量样式渐进跟随。

#### Scenario: 应用启动加载 MD3 主题

- **WHEN** 应用启动渲染
- **THEN** MUI ThemeProvider 注入 MD3 主题，`--color-*` CSS 变量值与当前主题令牌一致

#### Scenario: 明暗切换

- **WHEN** 用户切换 light/dark 主题
- **THEN** MUI 组件与存量 CSS 变量驱动的界面同步切换

### Requirement: 组件全面使用 MUI（Material Design 组件库）

界面组件 SHALL 使用 @mui/material 对应组件实现（Button/IconButton/Dialog/Drawer/
Menu/TextField/Tooltip/Paper/Card 等），自研组件仅保留：画布几何与定位逻辑、
WinBox 窗体容器、端口连线几何；自研图标体系保留。

#### Scenario: 弹窗工具栏 MD 化且行为不变

- **WHEN** 用户在画布选中元素
- **THEN** popup-toolbar 以 MUI 组件渲染，定位/删除（button.trash）/快捷键行为不变

#### Scenario: 工作流节点卡片 MD 化且连线可用

- **WHEN** 工作流节点渲染
- **THEN** 卡片使用 MUI Card/TextField/Chip，端口拖拽连线与 `.wf-node-*` 选择器
  行为不变

### Requirement: E2E 与埋点钩子全量保留

迁移 SHALL 透传/保留全部测试与统计钩子：data-testid、className 钩子（button.trash、
side-drawer--toolbar-right、wf-node-* 等）、aria-label、radio 语义、data-track；
84 个 E2E 用例全量跑绿为迁移完成的准入条件。

#### Scenario: 按钮统计采集不受影响

- **WHEN** 迁移后的按钮被点击
- **THEN** 采集器仍能按 data-track/testid/aria-label/text 解析按钮标识并上报

#### Scenario: E2E 全绿准入

- **WHEN** 迁移批次完成
- **THEN** smoke+functional E2E 全部通过后方可交付
