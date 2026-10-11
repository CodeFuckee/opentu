# Tasks: adopt-material-design-3

> 实施约定：同一方案内连续实施；每个批次完成时构建+单测必须保持全绿；
> 全部批次完成后跑全量 E2E 并交用户过目。

## 批次 1：主题基座

- [ ] 1.1 安装 @mui/material @emotion/react @emotion/styled（lockfile 内网分发确认）
- [ ] 1.2 `theme/md3-theme.ts`：种子色 #F39C12 生成 MD3 调色板；light/dark 双主题；
      typography/shape/elevation MD3 规范；系统字体栈
- [ ] 1.3 CSS 变量桥：MD3 token → 既有 `--color-*` 变量回写（存量 SCSS 渐进跟随）
- [ ] 1.4 ThemeProvider + CssBaseline 挂载 drawnix 根与 apps/web 登录壳（对接
      ThemeMode light/dark 切换）

## 批次 2：基础原语

- [ ] 2.1 ToolButton → IconButton/ToggleButton 体系（className/aria/testid/data-track
      透传）
- [ ] 2.2 Dialog/ttd-dialog 基座 → MUI Dialog（settings/sync/backup/custom-tool 跟随）
- [ ] 2.3 Island → Paper；Menu/ContextMenu → MUI Menu；HoverTip → MUI Tooltip
- [ ] 2.4 输入类基座：TextField/Select/Switch/Checkbox 替换自研表单件

## 批次 3：壳层页面

- [ ] 3.1 apps/web 登录门禁/auth-form/user-menu → MUI（data-testid auth-gate 保留）
- [ ] 3.2 startup 引导/version-update/feedback-button/cache-quota 提示

## 批次 4：工具栏族

- [ ] 4.1 unified-toolbar/app-toolbar（data-testid 保留）
- [ ] 4.2 creation-toolbar（radio 语义保留）/quick-creation/freehand/pen-settings/
      pencil-mode/fill-panel/shape-picker/arrow-picker
- [ ] 4.3 popup-toolbar（定位与事件逻辑不动，组件 MD 化，button.trash 保留）
- [ ] 4.4 toolbar-context-menu/more-tools-button/minimized-tools-bar/view-navigation

## 批次 5：抽屉与面板

- [ ] 5.1 side-drawer/toolbox-drawer/project-drawer（`.side-drawer--toolbar-right`
      保留）
- [ ] 5.2 task-queue（VirtualTaskList/TaskItem/DialogTaskList）
- [ ] 5.3 chat-drawer（SessionList/SessionItem/ModelSelector/MessageBubble）

## 批次 6：业务模块

- [ ] 6.1 ai-input-bar 全家（parameters-dropdown/PromptSuggestion/HistoryPopover/
      KeyboardDropdown）
- [ ] 6.2 media-library(WinBox 内容区)/official-library/template-gallery/
      generation-history
- [ ] 6.3 knowledge-base/MarkdownEditor/MarkdownReadonly/lazy-image
- [ ] 6.4 inspiration-board/character/backup-restore/sync-status/canvas-search/
      command-palette

## 批次 7：画布元素与编辑器

- [ ] 7.1 workflow-node-element 卡片 MD 化（端口几何不动，`.wf-node-*` 保留）
- [ ] 7.2 image-editor 工具条/canvas-edit banner/image-generation-anchor/
      card-element/frame-element/audio-node-element/workzone-element
- [ ] 7.3 multi-selection-handles/minimap/performance-panel/tool-element

## 批次 8：长尾与多页应用

- [ ] 8.1 mv-creator/comic-creator/music-analyzer/video-analyzer/video-frame-selector
- [ ] 8.2 model-benchmark/official 库详情/storyboard/StoryboardEditor 等长尾
- [ ] 8.3 dashboard-stats HTML 配色对齐 MD3 令牌

## 批次 9：收尾验证

- [ ] 9.1 全量单测（drawnix/web/函数）+ typecheck + lint
- [ ] 9.2 全量 E2E（smoke+functional）跑绿，选择器修复清单归档
- [ ] 9.3 CHANGELOG + docs（md3 主题使用说明：新增组件一律用 MUI）
- [ ] 9.4 本地启动过目（含画布浮层与抽屉）→ 推送 → 流水线全绿
