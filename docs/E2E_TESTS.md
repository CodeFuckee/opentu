# E2E 测试说明与设计文档（Yue画布）

本文档说明仓库内 **Playwright E2E 测试**的完整覆盖范围与设计思路：每个测试测什么、
为什么要这样测、以及如何运行。

- 测试所在目录：`apps/web-e2e/`
- 测试框架：Playwright Test（TypeScript），经 Nx `web-e2e` 项目接入
- 涉及应用：`apps/web`（Yue画布 白板工作台）

---

## 1. 总览

### 1.1 分层策略

整个 E2E 套件按**执行速度与稳定责任**分层：

| 层级 | 项目名 | 用例数 | 目的 | 何时运行 |
|------|--------|--------|------|----------|
| 认证预置 | `auth-setup` | 1 | 注册一次性测试账号并登录，保存 `storageState` | 每次运行自动执行（被依赖） |
| 冒烟 | `smoke` | 2 | 应用可启动、核心容器齐全、主流程浅链路 | PR / CI 快速门禁 |
| 视觉回归 | `visual` 及 `responsive`/`mobile-*`/`tablet` | 41 | 像素级回归（截图对比） | CI / 发布前 |
| 功能（多浏览器） | `chromium` / `firefox` / `webkit` | 3 | 跨浏览器核心功能 | 发布前 |
| 功能（补充，详测） | `functional` | 41 | 画布编辑、抽屉、菜单、素材库、云端同步（跨设备）等深度交互 | 发布前 / 本地验证 |
| 手册生成 | `manual` / `manual-video` | 20 | 为《用户手册》生成带标注截图与 GIF | 手动触发 |

> 用例数按当前文件统计，新增用例后以实际为准。

### 1.2 认证：为什么有一个 `auth-setup`

2026-08 起，应用在工作区前引入 **Supabase 登录门禁**（`AuthGate`），未登录时只渲染登录表单。
此前编写的 E2E 套件（smoke/visual/features/manual）直接 `goto('/')` 等待 `.drawnix`，
在门禁之后会全部失败——这也是本套件需要一次重构的根因。

新方案：

1. `apps/web-e2e/src/setup/auth.setup.ts` 作为 Playwright **setup 项目**：
   - 通过 GoTrue REST API 注册一个**一次性测试账号**（后端 `mailer_autoconfirm=true`，注册即登录）；
   - 打开应用，走**真实 UI 登录表单**（oa账号 + 密码，见 `docs/supabase-auth-implementation.md`）；
   - 等待 `.drawnix` 出现后，将会话保存为 `test-results/e2e-auth-state.json`（`storageState`）。
2. 其余每个项目声明 `dependencies: ['auth-setup']` + `use.storageState`，以**已登录状态**运行，
   避免每个测试重复登录（登录开销只承担一次）。

**运行前提**：本地/CI 环境必须能访问 Supabase 后端（默认读取 `apps/web/.env` 的
`VITE_SUPABASE_URL`，可用 `E2E_SUPABASE_URL` / `E2E_SUPABASE_ANON_KEY` / `E2E_TEST_PASSWORD`
环境变量覆盖）；后端不可达时 setup 会明确失败并提示环境问题，而不是让全部用例随机超时。

### 1.3 公共基础设施

| 文件 | 作用 |
|------|------|
| `src/fixtures/test-base.ts` | 扩展测试基类：自动收集 `console.error`（视为失败）与 `console.warning`（附件记录），出现 pageerror 也失败 |
| `src/fixtures/e2e-auth.ts` | 认证辅助：读取 Supabase 配置、生成一次性账号、`storageState` 路径 |
| `src/fixtures/canvas-helpers.ts` | 画布交互辅助：工具 radio 点击、视口坐标换算、元素计数轮询、关闭灵感板、绘制矩形等 |
| `src/fixtures/test-app.ts` | `DrawnixApp` Page Object（历史遗留，部分选择器已过时，新增用例优先用 data-testid/data-track） |
| `src/utils/screenshot-annotations.ts` | 手册截图标注工具（圆框/箭头/高亮） |

### 1.4 选择器约定（重要）

应用 UI 有两套稳定的钩子，测试优先使用（LESSONS 来自真实 DOM 侦察验证）：

- `data-testid="..."`：组件根容器，如 `ai-input-bar`、`view-navigation`、`toolbar-project`、
  `project-drawer`、`task-queue-panel`、`chat-drawer`、`popup-toolbar`、`settings-dialog` 等。
- `data-track="..."`：埋点钩子，同时是稳定的交互定位，如 `toolbar_click_more`、
  `toolbar_click_menu_settings`、`toolbar_click_menu_backup`、`view_nav_zoom_fit`、
  `chat_click_drawer_open`、`inspiration_click_hide`、`toolbar_click_mind` 等。
- 菜单项是 `role="menuitem"`，不是普通 button；WinBox 窗口无 `data-testid` 透传
  （用 `.winbox-*` 类名定位，如 `winbox-media-library`、`winbox-settings-window`），
  其关闭按钮是 `.wb-close`。
- 工具切换 radio 是受控 input（`label.tool-icon` 包裹），必须点击其**直接父级 label**，
  `check()` 或点击外层 div 都无法切换选中态（见 `clickToolRadio`）。
- 画布 `board-host-svg` 尺寸 2560×1440 且居中于视口，**旧测试用 SVG 左上角坐标会导致
  绘制落在视口外**。统一用「视口中心 + 偏移」（`screenAt`）定位；空画布上灵感板会拦截
  指针事件，绘制前需先关闭（`dismissInspirationBoard`）。
- 元素创建/删除是异步渲染，用 `expect.poll` 轮询元素数量（`element-host [plait-data-id]`），
  不使用固定 `sleep`。
- 快捷键依赖画布焦点：键盘切换工具/撤销/重做前先 `focusCanvasEmptyArea` 把焦点还给画布宿主。

---

## 2. 每个测试在测什么

以下按目录逐条说明（`functional` 为本次新增的主力详测套件）。

### 2.1 smoke（冒烟）— `src/smoke/smoke.spec.ts`

1）**主画布：加载、工具栏、AI输入栏、视图导航**

- 验证页面标题含「Yue画布」、画布 `.drawnix` 可见（应用能启动）；
- 工具栏手形/选择工具存在且可点击切换；
- 画笔、形状按钮存在；
- AI 输入栏可见、输入内容可保留；并校验 **textarea 自动高度**：单行约等于 4 行高、
  7 行输入时封顶 6 行高且出现纵向滚动条（防止输入框无限长高破坏布局）；
- 模型选择器存在并可打开/关闭；
- 缩放：点击放大后缩放百分比显示变化（视图导航可用）。

2）**弹窗抽屉：设置、项目、工具箱**

- 项目抽屉 / 工具箱抽屉能打开并出现对应标题（h3「项目」「工具箱」）；
- 「更多」应用菜单可打开并关闭，不报 console error。
- 说明：此用例只验证「能打开」，详细交互交给 functional 套件。

### 2.2 features（功能·多浏览器）— `src/features/features.spec.ts`

1）**主画布：AI输入、绘图工具**

- AI 输入栏输入长提示词、模型选择器打开/关闭、尺寸选择器打开/关闭；
- 灵感创意板：模板「智能拆分宫格图」点击后提示词自动填充、出现发送引导、可返回；
- 画笔绘制一笔、形状工具点击放置一个元素（在桌面 Chromium/Firefox/WebKit 三种引擎上都执行，
  保障跨浏览器基础交互一致）。

2）**弹窗抽屉：设置、项目管理**

- 项目抽屉打开：标题、新建画板/新建目录、导入/导出按钮齐全；
- 工具箱抽屉打开：全部/内容工具/AI 工具分类按钮可切换。

3）**素材库：打开关闭**

- 「素材库」工具打开素材库面板并可用 Escape 关闭（不抛错）。

> 说明：本文件是旧套件，已同步更新到当前 UI（如「新建目录」）；跨浏览器职责由它承担，
> 深交互不再重复，避免与 functional 套件重叠。

### 2.3 functional（功能·补充详测，Chromium）— `src/functional/`

> 这是本次新增的主力套件，37 个用例，覆盖“真实用户会做的深度操作”，
> 每个用例都以**可观察的状态变化**为断言（出现/消失/数量增减/文本变化），不是“点了不报错”。

**canvas-basics.spec.ts（画布基础与工具）**

1. `工作区加载` — 标题、画布、统一工具栏、AI 输入栏、视图导航全部可见（应用整体可用的最小集）。
2. `统一工具栏核心按钮齐全` — 画笔/形状/更多/项目/工具箱/任务队列/用户菜单入口存在（已登录态）。
3. `工具切换选中态` — 选择(默认选中)→手形→文本 依次切换，radio `checked` 跟随（受控工具状态）。
4. `更多菜单` — 思维导图/箭头/Markdown与Mermaid到Drawnix/撤销/重做入口在更多菜单中可见。

**view-navigation.spec.ts（视图导航）**

5. `放大/缩小` — 点击放大后百分比变化，再缩小后再次变化（zoom 状态更新）。
6. `缩放菜单 100%` — 放大偏离 100% 后，通过缩放菜单「100%」恢复（菜单项真实生效）。
7. `缩放菜单自适应` — 「自适应/框选自适应」菜单项存在（可一键适配视图能力存在）。
8. `小地图切换` — 小地图初始可见，点击切换展开/收起往返（状态正确翻转）。

**drawing.spec.ts（绘制与编辑，核心）**

9. `画笔绘制` — 键盘 P 激活毡尖画笔，画一笔后 `element-host` 出现 `plait-freehand` 元素
   （自由画笔真正落盘）。
10. `形状绘制并可选中` — 绘制 Rectangle 后出现 `plait-geometry` 元素，点击弹出工具栏，
    含「删除/填充颜色」（几何元素可被选中、可编辑）。
11. `文本插入` — 文本工具点击画布、输入「E2E 文本测试」、提交后元素宿主内出现该文本
    （文本元素真实创建并提交）。
12. `删除元素` — 选中元素后经弹出工具栏「删除」，元素数量减少（删除链路通）。
13. `撤销/重做` — 绘制后 Ctrl+Z 元素减少、Ctrl+Shift+Z 元素恢复（历史栈可用；
    含“选中态下首次撤销可能只清选中”的重试兜底）。

**ai-input-bar.spec.ts（AI 输入栏）**

14. `提示词输入` — 输入内容保留在文本域（值校验）。
15. `模型选择器打开` — 下拉出现 `role=option` 列表，面板文本含模型标识（gpt/gemini/flux 等）。
16. `模型选择器选择` — 从列表选「gpt-image-2-vip」后触发按钮文本变化（选择真正生效）。
17. `尺寸参数选择器` — 打开后弹层含「图片尺寸/画质」等配置（参数面板可用）。
18. `发送按钮` — 输入提示词后发送按钮可用（非 disabled 态）。

**inspiration-board.spec.ts（灵感创意板）**

19. `空画布展示灵感板` — 空画布时灵感板 + 模板卡片可见（新用户引导存在）。
20. `点击模板填充提示词并可返回` — 点「智能拆分宫格图」→ 提示词填充 + 发送引导 + 返回恢复列表
    （引导闭环可用）。
21. `不再提示` — 点击后灵感板消失（偏好可持久关闭）。

**project-drawer.spec.ts（项目抽屉）**

22. `打开/关闭` — 项目按钮打开抽屉，标题「项目」、标签（画布管理/PPT编辑/图层）、
    新建画板/新建目录/导入/导出齐全，再点按钮关闭。
23. `切换到 PPT 编辑标签` — 点 PPT 标签进入选中态（标签切换真实生效）。

**toolbox-drawer.spec.ts（工具箱抽屉）**

24. `打开并展示分类` — 全部/AI工具/内容工具/实用工具分类按钮可见。
25. `分类切换` — 点 AI 工具后内容区出现 AI 工具（多图生成/爆款视频生成），
    切回全部后内容工具（我的提示词/知识库）回归（过滤真实生效）。
26. `关闭` — 再次点击工具箱按钮抽屉隐藏。

**app-menu.spec.ts（应用菜单与对话框）**

27. `菜单核心文件操作` — 菜单含打开/保存/导出/清除/备份/设置（menuitem 语义断言）。
28. `设置对话框` — 打开设置（WinBox），验证可见后经 `.wb-close` 关闭
    （WinBox 语义，Escape 不关闭）。
29. `备份恢复对话框` — 打开含导出/恢复能力，Escape 关闭。

**media-library.spec.ts（素材库）**

30. `打开并展示筛选与空态` — WinBox 窗口可见、分类（图片/视频/音频/本地/AI）、
    空态「暂无素材」、视图切换（网格/紧凑/列表）齐全。
31. `关闭` — 经 WinBox `.wb-close` 关闭。

**chat-drawer.spec.ts（聊天抽屉）**

32. `展开并展示会话结构` — 打开后新对话/会话列表/输入区可见，可收起。
33. `新对话` — 点「新对话」出现「开始对话」引导（创建会话闭环）。
34. `聊天模型选择器` — 抽屉内模型选择入口存在。

**task-queue.spec.ts（任务队列）**

35. `展开并展示状态标签与空态` — 标签（全部/生成中/失败/已完成）+ 新账号空态「暂无任务」。
36. `收起` — 再点任务队列按钮面板隐藏。

**cloud-sync.spec.ts（云端同步 · 跨设备）**

37. `设备A新建画板+图片同步后，设备B同步能看到` — 无痕浏览器完整模拟跨设备云同步闭环：
    设备 A 登录 → 新建 16 位随机名画板 → 插入本地图片 → 「立即同步」→ 用 Supabase REST
    验证 `user_sync_data` 写入该画板记录（RLS 查自己的数据）→ 关闭 context → 设备 B
    全新无痕登录 → 「立即同步」→ 项目抽屉出现同名画板 → 打开后画布含图片元素。
    （依赖 Supabase 后端可达 + `user_sync_data`/`user_sync_media` 表已部署；
    插入图片通过 `addInitScript` 禁用 `showOpenFilePicker` 强制回退 hidden input，
    用 `filechooser` 提供本地测试图。）
38. `立即同步 / 下载远程 / 上传本地三操作画板数量一致（回归）` — 覆盖三个同步按钮：
    设备 A 建两个画板 → 「上传本地」→ 设备 B 「下载远程」得到云端画板 →
    再「立即同步」画板数量与下载远程**一致**（回归：墓碑不复活、不丢画板）→
    最后「上传本地」数量不变。上传/下载按钮带确认弹窗流程。

**cloud-sync-image-display.spec.ts（云端同步 · 图片显示与控制台报错）**

39. `新浏览器同账号同步后打开画板：控制台无报错且图片正常显示` — 按手册步骤 1:1 复现
    跨设备图片同步：设备 A 打开画布并插入 `apps/web-e2e/images/test1.png` → 「立即同步」
    → 全新无痕浏览器（= 另一台设备）同账号登录 → 「立即同步」→ 项目抽屉打开同一画板：
    - 步骤 7：设备 A/B 从页面创建起收集 `console error`/`pageerror`，**断言全程无报错**
      （失败时残留的 404 / `[UnifiedCache] Failed to cache image` 类错误即复现信号）；
    - 步骤 8：图片**真实解码渲染**（`img.image-origin` 可见、`naturalWidth > 0`、
      非 hidden、画布内非零尺寸），而非只验证元素存在；
    - 诊断留档：无论成败都 attach 控制台日志、`/asset-library` 网络响应状态、
      媒体行与 storage 对象的云端探测（`probeRemoteMediaObject`）、设备 B 的 Cache
      与 img 最终状态，便于区分「应用缺陷」与「测试环境干扰」。
    - 图片元素按 `plait-data-id`（元素 id）追踪，跨同步稳定；等待媒体 blob 落地
      Cache 后再断言，避免 img 首帧 404 的时序噪音。
    对应 2026-09 修复的「`cache_media` 元数据误判『本地已有』导致媒体二进制
    永不下载」问题（详见 `docs/cloud-sync.md`）。

> 说明：AI 生成链路（发送提示词→任务队列→生成图片）需要真实模型 APIKey，E2E 不触发真实
> 计费请求，只验证 _界面闭环_（输入、模型选择、参数面板、任务面板空态）。真实生成由
> `manual-gen/gif-recordings.manual.spec.ts`（手册演示）在配置好 Key 的环境中覆盖。

### 2.4 visual（视觉回归）— `src/visual/`

通过 `toHaveScreenshot` 做像素级对比，基线在 `*-snapshots/` 目录（按平台后缀）。

- `visual.spec.ts`：主画布整体（工具栏/AI输入栏/视图导航）、项目/工具箱抽屉截图。
- `page-visual.spec.ts`：页面级 —— 初始加载、空画布+灵感板、项目/工具箱/聊天/素材库/设置打开、
  多面板并存。
- `drawer-visual.spec.ts`：项目抽屉（默认/搜索）、工具箱抽屉（全部/内容/AI分类）、
  聊天抽屉（空会话/会话列表）、任务队列空态。
- `interaction-visual.spec.ts`：交互状态 —— 抽屉开关、工具选中（画笔/形状/文本）、
  下拉开关（模型/尺寸）、缩放变化、绘图前后、悬停、输入前后。
- `responsive-visual.spec.ts`：桌面/平板/移动端多视口布局 + 触控区域；由
  `responsive`/`mobile-chrome`/`mobile-safari`/`tablet` 项目按设备运行。

> 基线文件是 `-darwin.png`（CI 在 macOS 生成）。升级 UI 或认证样式后需用
> `pnpm e2e:visual:update` 重新生成基线。视觉用例同时声明了
> `maxDiffPixelRatio: 0.05`（允许 5% 像素差异，容忍字体渲染噪声）。

### 2.5 manual-gen（手册生成，非断言）

为《用户手册》生成带标注截图与 GIF，**不追求断言，而是作为“有据可查的演示脚本”**
（若期间 UI 变化导致脚本失效即视为信号）：

- `basics.manual.spec.ts`：画布操作、插入内容、快捷键演示截图。
- `drawing.manual.spec.ts`：画笔绘制、创建形状、添加文本、创建思维导图（Markdown→Drawnix）、
  创建流程图。
- `ai-generation.manual.spec.ts`：AI 生成图片入口、灵感创意板、视频生成入口。
- `advanced.manual.spec.ts`：工具箱、调试面板、编辑操作、项目管理、素材库、设置、备份恢复、
  图片预览编辑。
- `gif-recordings.manual.spec.ts`：约 15 段 GIF 录制（思维导图/画笔/AI生成/工具箱/素材库/
  项目管理/备份恢复/AI输入栏/模型选择/参数配置/多模态/ChatDrawer/会话管理/智能提示/灵感/工作流）。
- `gif-dsl.manual.spec.ts`：GIF DSL 通用录制器（按 manifest 批量录制）。

运行：`pnpm e2e:manual`（截图）、`pnpm manual:gif`（GIF+手册渲染）。

---

## 3. 怎么运行

```bash
# 完整 E2E（所有项目；本地无多引擎时可能失败，CI 已装全）
pnpm e2e

# 分层运行
pnpm e2e:smoke          # 冒烟（快速门禁）
pnpm e2e:features       # 功能（Chromium）
pnpm e2e:functional     # 补充详测（本次新增）
pnpm e2e:visual         # 视觉回归
pnpm e2e:manual         # 手册截图生成

# 视觉基线
pnpm e2e:visual:update  # 更新截图基线

# 报告
pnpm e2e:visual:report  # 打开 HTML 报告
```

细节：

- Playwright 配置在 `apps/web-e2e/playwright.config.ts`，`webServer` 自动
  `nx serve web` 到 `http://localhost:7200`（本地已起服务时复用，`reuseExistingServer`）。
- 可用 `BASE_URL` 指向已部署环境（如 CI 对线上回归）。
- 认证：首次运行先注册一次性账号并登录；如需固定账号，设置
  `E2E_SUPABASE_URL` / `E2E_SUPABASE_ANON_KEY` / `E2E_TEST_PASSWORD`。

---

### 3.1 Nx 目标说明

- `web-e2e:e2e` 目标在 `apps/web-e2e/project.json` 显式声明（`nx:run-commands` 执行 `playwright test`），
  不依赖 `@nx/playwright/plugin` 推断缓存；`nx show project web-e2e` 应能看到 `e2e` 与 `e2e-ci*` 目标。
- 若出现 `Cannot find configuration for task web-e2e:e2e`，多为 Nx daemon 工程图缓存过期，
  执行 `npx nx reset` 后重试。

---

## 3.2 有头（headed）模式运行

Playwright 默认无头运行，需要可视化调试（观察真实窗口、排查布局/交互）时：

```bash
# 在 apps/web-e2e 目录直接运行（最常见）
npx playwright test --project=functional --headed

# 经 pnpm / Nx 脚本运行（--headed 会透传给 playwright）
pnpm e2e:smoke --headed
pnpm e2e:functional --headed

# 单个用例 + 有头
npx playwright test src/functional/drawing.spec.ts --project=functional --headed

# 调试模式：有头 + Playwright Inspector（逐步查看/暂停）
PWDEBUG=1 npx playwright test src/functional/canvas-basics.spec.ts --project=functional
```

注意事项：

- **需要完整浏览器可执行文件**：有头模式不使用 headless-shell，必须安装完整 Chromium
  （本机已装到 `%LOCALAPPDATA%\ms-playwright\chromium-1200\chrome-win64\chrome.exe`；
  其他机器执行 `npx playwright install chromium`）。缺浏览器会报
  `Executable doesn't exist ... chrome.exe`。
- **CI/无显示器环境**：headed 需要桌面会话，CI 上不要加 `--headed`。
- 与 `--ua` 无关：Playwright 有头/无头共用一套测试代码；`--headed` 只是启动方式差别。
- 失败产物（截图/视频/trace）在 `apps/web-e2e/test-results/`，与有头/无头无关。

---

## 4. 设计原则（为什么这样写）

1. **先分后合**：冒烟只负责“快”，深交互归 `functional`，多浏览器归 `features`，
   视觉归快照，手册归演示 —— 职责单一，避免一个文件里混多种断言风格。
2. **断言状态变化而非“点了不报错”**：旧套件大量用例是“点击 + 不断言”，
   元素是否真的创建/删除无从得知。functional 全部改为可观察断言：
   元素计数增减（`expect.poll`）、文字出现/消失、radio checked、面板可见性。
3. **认证是可运行性前提**：应用加了登录门禁后，任何工作区用例必须先登录；
   用 setup 项目 + storageState 把这件“每用例重复的事”收敛为一次。
4. **坐标以视口中心为锚**：画布 SVG 大于视口，用左上角坐标是历史坑（画到视口外）。
5. **选择器优先语义钩子**：`data-testid`/`data-track`/`role`；尽量避免
   `div.filter({has:...})` 这类脆弱定位（旧用例遗留，新用例不再引入）。
6. **异步一律轮询**：元素创建/删除/缩放值变化用 `expect.poll`，固定 `sleep` 只用于
   等动画/防抖的极少数场景。
7. **失败可诊断**：`test-base` 把 console error 直接判失败（提前暴露前端异常），
   失败自动截图+录视频+错误上下文；reporter 同时输出 html/json/list。
8. **不碰真实 AI 计费**：验证 UI 闭环，不触发真实生成请求，避免 E2E 引入外部成本与抖动。
9. **贴近真实用户路径**：登录走真实表单、工具用真实交互（键盘/鼠标/子面板），
   而不是直接调内部 API —— 保证“用户能完成这件事”。

---

## 5. 补充说明与已知边界

- **视觉基线平台**：现有基线为 darwin；Windows/linux 需要各自 `--update-snapshots` 建立基线。
- **`test-app.ts` Page Object 部分选择器过时**（如 `.chat-drawer__input`），
  但不影响运行；建议后续将其收敛到 data-testid 体系或移除（保持“断舍离”）。
- **多浏览器**：`features` 三引擎运行；`functional` 目前仅 Chromium（交互对引擎差异敏感，
  成本收益比低），如需要可在 config 里为 functional 增加 firefox/webkit 项目。
- **AI 生成真实链路**：需要真实 Key，测试环境通过 `manual-gen/gif-recordings` 覆盖并人工确认。

---

*文档维护：新增/删除 E2E 用例时请同步更新第 2 节清单。*