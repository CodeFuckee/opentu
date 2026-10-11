# Change: 前端全面迁移 Material Design 3——MUI 组件库 + MD3 主题（全量）

## Why

产品决定将前端视觉与组件体系统一迁移到 Material Design 规范：当前自研组件体系
（ToolButton/Island/Dialog/Drawer 等 tldraw 风格，319 个组件文件、146 个 SCSS）维护
成本高、无规范背书。用户拍板：**MUI 组件库、全量一次迁移、画布浮层一并 MD 化**。

## What Changes

### 1. 依赖与主题基座

- 新增 `@mui/material` `@emotion/react` `@emotion/styled`（按需摇树，不引入
  @mui/icons-material——保留自研 icons.tsx 图标体系）
- 新增 `packages/drawnix/src/theme/md3-theme.ts`：以品牌橙 `#F39C12` 为种子色生成
  MD3 调色板（primary/secondary/tertiary/surface/outline/error 全套 color roles），
  light + dark 双 `createTheme` 对接现有 ThemeMode；typography/shape/elevation 按
  MD3 规范；fontFamily 用系统字体栈（内网无 Google Fonts CDN）
- **CSS 变量桥**：ThemeProvider 将 MD3 token 回写既有 `--color-*` CSS 变量——存量
  146 个 SCSS 的颜色引用渐进跟随新主题，避免一次性重写全部样式文件
- `ThemeProvider` + `CssBaseline` 挂载 drawnix 根组件与 apps/web 登录壳

### 2. 组件全量迁移映射（自研 → MUI）

| 自研 | MUI | 备注 |
| --- | --- | --- |
| ToolButton / creation-toolbar 单选工具 | IconButton / ToggleButtonGroup / RadioGroup | 保留 radio 语义（E2E getByRole('radio') 依赖） |
| Dialog / ttd-dialog / settings-dialog / sync-settings / backup-restore / custom-tool-dialog | MUI Dialog | 保留 data-testid |
| Island | MUI Paper（elevation 映射） | 保留 island 布局行为 |
| Menu / ContextMenu / toolbar-context-menu / more-tools-button | MUI Menu / MenuItem | |
| HoverTip / 各处 tooltip | MUI Tooltip | 满足 hover-usage 门禁规则 |
| 输入类：搜索框/表单/开关/下拉 | TextField / Select / Switch / Checkbox | |
| unified-toolbar / app-toolbar / view-navigation / zoom | MUI 组合 | 保留 data-testid（unified-toolbar 等） |
| **画布浮动工具栏 / popup-toolbar** | MUI Paper + IconButton 组合 | **保留全部定位/拖拽/事件逻辑**，className（trash 等）/aria-label/testid/data-track 全量透传 |
| **workflow-node-element 节点卡片** | MUI Card + TextField + Chip | **端口（port）保持自定义绝对定位**（连线路由依赖几何） |
| side-drawer / toolbox-drawer / project-drawer / chat-drawer / task-queue | MUI Drawer / List / ListItem / Badge | 保留 `.side-drawer--toolbar-right` 等选择器 |
| ai-input-bar / parameters-dropdown / PromptSuggestionPanel | MUI TextField / Menu / Chip | |
| media-library(WinBox) / official-library / template-gallery / knowledge-base / generation-history | MUI 窗体化组合（WinBox 容器保留） | 内容区组件 MD 化 |
| image-editor / canvas-edit banner / image-generation-anchor / card-element / frame-element | MUI 组合 | 画布几何逻辑不动 |
| mv-creator / comic-creator / music-analyzer / video-analyzer / character / inspiration-board / command-palette / minimap / performance-panel / version-update / feedback-button 等 | 对应 MUI 组件 | 长尾批次 |
| apps/web：auth-gate / auth-form / user-menu | MUI TextField / Button / Alert / Menu | 登录壳同主题 |

### 3. 兼容与测试保障

- **选择器兼容红线**：所有被 E2E 依赖的钩子全量透传/保留——`data-testid`（
  unified-toolbar/popup-toolbar/toolbar-toolbox/auth-gate 等）、`className`（
  button.trash、side-drawer--toolbar-right、wf-node-*、asset-item、drawnix 等）、
  `aria-label`、radio 语义、`data-track`（按钮统计采集器依赖）
- 84 个 E2E 全量跑绿为准入条件；hover-usage 门禁（禁原生 title）继续满足
- dashboard-stats（服务端自包含 HTML，非 React）：内联 CSS 色值对齐 MD3 令牌
- 风险声明：改造面覆盖全部 UI；实施期间每批次保持构建与测试全绿（单批次内完成，
  不做跨发布的状态切割），批次顺序=用户视线权重（壳层→工具栏→抽屉→业务→长尾）

## Impact

- Affected specs: 新增 `md3-ui` capability（主题系统与迁移规范）
- Affected code:
  - `packages/drawnix/src/theme/`（新增）、`drawnix.tsx`（Provider 挂载）
  - `packages/drawnix/src/components/**`（319 文件按映射表迁移）
  - `apps/web/src/supabase/auth-*`、`apps/web/src/app/bootstrap.tsx`
  - `supabase/functions/dashboard-stats/core.ts`（HTML 配色对齐）
  - `apps/web-e2e/src/**`（选择器修复）
  - `package.json`（3 个新依赖）、CHANGELOG
- 不动：画布几何/连线/引擎逻辑、workflow 引擎、后端接口、按钮统计采集器（data-track 透传）
