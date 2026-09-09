# 项目优化与深入方向评估（2026-09）

> 评估基线：v1.0.10（main @ 0d870e4f）。结论基于对仓库的全面侦察：
> 主代码约 8.8 万行 ts/tsx（不含 feedbackland vendored 代码），
> 涉及 packages/drawnix、apps/web、supabase/functions、apps/web-e2e。

## 总体判断

项目功能面已经很宽（画布 + 多模型生成 + PPT/漫画/MV 工作流 + 云同步 +
反馈平台 + 数据看板），工程习惯良好（openspec 变更提案流程、`*_LESSONS`
复盘文档、E2E 双环境覆盖）。当前最大的问题不是缺功能，而是：

1. **安全上有一个必须马上止血的洞**（secret.md 泄露）；
2. **核心执行链路缺测试**（workflow engine、tools、SW）;
3. **几个巨石文件在拖慢迭代**。

产品方向上，实时协作和国际化是两块最大的空白。

---

## P0：安全止血（建议立即处理）

### 1. secret.md 泄露数据库密码 🔴

- `secret.md` 被 git 跟踪（`git ls-files` 确认），内容为 Supabase 数据库
  真实账号/密码（commit `dec6e4ca` 起进入历史）。
- 光删文件没用，密码已进 git 历史。正确做法：
  1. **立即轮换 Supabase 数据库密码**；
  2. 用 `git filter-repo` / BFG 从全部历史中清除该文件；
  3. 仓库若已推到远端，视同密码已泄露（轮换是唯一有效手段）。

### 2. dashboard-stats 边缘函数无鉴权

- `supabase/functions/dashboard-stats/index.ts:13` 自注释：
  `鉴权：暂不做（本函数不校验调用者；页面 JS 带 anon key 供 Kong 放行）`；
  `:25` 为 `Access-Control-Allow-Origin: '*'`。
- 任何人拿 anon key 即可拉取全库聚合统计，包含用户邮箱、OA 账号、
  部门、月度用量等。
- `core.ts:11` 已自留升级路径（函数内加管理员判定，或 Kong 网络层限制），
  照做即可。顺带复核 `check-email` / `check-register` / `sync-staff-profile`
  / `newapi-key` 的调用者校验（均以 service_role 直写库，未发现 JWT 校验）。

### 3. MermaidRenderer XSS 面

- `packages/drawnix/src/components/chat-drawer/MermaidRenderer.tsx`:
  - `:106-109` `mermaid.initialize({ securityLevel: 'loose' })`；
  - `:202` `dangerouslySetInnerHTML={{ __html: svgContent }}` 直插
    AI 生成的 SVG，全库唯一的注入点，grep 无 sanitize/DOMPurify。
- 修复：加 DOMPurify 消毒，或将 securityLevel 改为 `strict`。

### 4. 内网 IP 硬编码进前端产物

- `packages/drawnix/src/constants.ts:61`：`FEEDBACKLAND_URL = 'http://10.37.80.25:8090'`
- `apps/web/src/supabase/supabase-client.ts:12`：fallback `'http://10.37.80.25:8021'`
- 另有 `services/managed-routing/managed-runtime.ts:17`、
  `services/cache-blob-fallback-store.ts:6`（注释）、`scripts/edge-function-smoke.mjs:23`。
- 问题：公网用户会看到指向内网的请求失败，且暴露内网拓扑。
  应收敛为环境变量（`VITE_*`），构建时注入。

---

## P1：质量地基（性价比最高的投入）

### 核心链路零测试

分层覆盖现状（drawnix src 内，源文件数 / 测试文件数）：

| 目录 | 源文件 | 测试 | 说明 |
| --- | --- | --- | --- |
| `engine/`（workflow 执行引擎） | 26 | **0** | WorkflowEngine、guards、parameter mapper 全裸奔 |
| `tools/`（工具注册与内置工具） | 15 | **0** | — |
| `stores/` | 1 | 0 | — |
| `plugins/`（画笔/画板核心插件） | 67 | 5 | — |
| `hooks/` | 59 | 5 | — |
| `services/` | 265 | 61 | 相对最好 |
| `utils/` | 148 | 44 | — |
| `components/` | 453 | 60 | — |

- `apps/web/src/sw/index.ts`（6853 行）只有
  `app-shell-routing.spec.ts`、`cdn-fallback.spec.ts` 两个测试。
- 亮点：supabase/functions 的 6 个边缘函数全部有 `core.test.ts`。
- **建议优先补 `engine/`**：它是任务编排的心脏，回归成本高，
  且相对纯（无 UI 依赖），测试写起来最划算。

### 拆巨石文件

>1800 行的文件共 21 个，最急需处理的：

| 行数 | 文件 | 备注 |
| --- | --- | --- |
| 6853 | `apps/web/src/sw/index.ts` | 按路由/缓存策略拆模块 |
| 5175 | `packages/drawnix/src/components/ai-input-bar/AIInputBar.tsx` | 145 个 React hook 调用，按 dropdown/历史/skill/workflow 拆 |
| 4219 | `packages/drawnix/src/components/project-drawer/FramePanel.tsx` | — |
| 3886 | `packages/drawnix/src/components/ttd-dialog/batch-image-generation.tsx` | — |
| 3198 | `packages/drawnix/src/components/settings-dialog/settings-dialog.tsx` | — |
| 3085 | `packages/drawnix/src/components/comic-creator/ComicCreator.tsx` | — |
| 2866 | `packages/drawnix/src/components/toolbar/popup-toolbar/popup-toolbar.tsx` | — |
| 2696 | `packages/drawnix/src/constants/model-config.ts` | 模型配置硬编码大表，可外置数据文件 |
| 2584 | `packages/drawnix/src/services/task-queue-service.ts` | 拆时顺手解开反向依赖（见下） |
| 2262 | `packages/drawnix/src/components/model-benchmark/ModelBenchmarkWorkbench.tsx` | — |
| 2167 | `packages/drawnix/src/utils/image-splitter.ts` | — |
| 1804 | `packages/drawnix/src/drawnix.tsx` | 根组件 76 个 import |

---

## P2：架构收敛（择机做）

### services → components 反向依赖

`services/task-queue-service.ts:61-80` import
`../components/video-analyzer/{types,storage,utils}`、
`../components/music-analyzer/...`、`../components/shared/...`——
服务层依赖组件层，storage 逻辑放错了位置，拆该文件时一并归位。

### services ↔ tools 双向依赖（潜在循环）

- 正向：`services/tool-window-service.ts:16`、`services/toolbox-service.ts:10`、
  `services/model-benchmark-launcher.ts:6` → `../tools/registry`；
- 反向：`tools/tools/music-player/MusicPlayerTool.tsx:45-46` →
  `services/canvas-audio-playback-service`、`services/tool-window-service`。

### 状态管理三种范式并存

6 个 Context（Asset/AudioPlaylist/ChatDrawer/ModelHealth/SupabaseSync/Workflow）
+ jotai + 根组件本地 state；`stores/` 目录名不副实（仅 1 个文件）。
建议定一个分层规则（如：跨域共享用 jotai、模块内用 Context）逐步归拢。

### temporaryModel 临时模型机制收敛

散落 8+ 处：`ChatDrawer.tsx:154/398/736/878`、`hooks/useChatHandler.ts:45/84/325`、
`services/chat-service.ts:207/294`、`utils/gemini-api/client.ts:98`。
temporaryModel 只在会话内生效、靠 ref 传递，是明显的过渡设计，
值得收敛为正式的「会话级模型覆盖」设计。

### 其他已知断点（TODO 清单精选）

- `plugins/with-tool.ts:83` — `TODO: 实现文本插入逻辑`（功能未实现）；
  `:71` 主题硬编码 light。
- `services/sw-capabilities/handler.ts:713` — 流式响应转发 SW 未完成。
- `services/long-video-chain-service.ts:259` — 长视频链路无进度反馈。
- `components/music-analyzer/pages/GeneratePage.tsx:207` — 拿不到真实
  clip_id 时创作链路断点。
- `apps/web/src/app/app.spec.tsx:3` — 占位假测试。

---

## P3：值得深入的产品方向

### 1. 实时多人协作

- 现状：全部 package.json 中无 `yjs` / `y-websocket` / `liveblocks` /
  `socket.io` / `hocuspocus` 任何依赖；源码无 `new WebSocket`。
  现有「云同步」是 `services/supabase-sync/` 的单人多设备最终一致同步，
  非并发协作。
- 判断：这是白板类产品（对标 tldraw / Excalidraw / Miro）最核心的
  差异化能力，README keywords 里也写了 collaboration。
- 建议：真要做需从选型（Yjs + 自建 WebSocket vs Liveblocks 托管）和
  画布数据模型改造开始，是大工程——先出 openspec 提案。

### 2. 国际化

- 现状：自研 i18n（`packages/drawnix/src/i18n.tsx`，手写 zh/en 字典），
  `useI18n()` 全库仅 63 处调用；components 下 296 个 .tsx 中
  **255 个（86%）含硬编码中文，共约 1.22 万处 CJK 字符串**；
  apps/web/src 另有 33 个文件。i18n 只覆盖了 toolbar/zoom 等骨架文案。
- 建议：先换标准方案（i18next + 提取脚本建基建），再分模块逐步迁移；
  工作量以万计字符串，需立项而非顺手做。

### 3. 运营侧深化：管理界面

dashboard-stats 目前只有只读看板，quota 已支持用户级覆盖
（`user_quota_configs` 表）。自然延伸是管理界面：改额度、封禁、
看任务明细，把「去 Supabase Table Editor 手改」的运维动作产品化。
可与 P0-2 的鉴权改造一并设计。

---

## 顺手的小事

- 仓库根目录约 15 个未跟踪的 e2e/test 调试日志
  （`e2e-trace*.log`、`test_frontend*.log`、`serve-7289.log` 等），
  补 `.gitignore` 或清理。
- `openspec/project.md` 全是模板占位符未填，对 AI 协作效率影响不小，
  值得花十分钟按实际技术栈/约定填写。

---

## 建议执行顺序

```
secret.md 止血（轮换密码 + 清历史）
  → dashboard-stats 鉴权 + MermaidRenderer 消毒 + 内网 IP 环境变量化
  → engine/ / tools/ 补测试
  → 拆 sw/index.ts 与 AIInputBar.tsx（顺手解 task-queue 反向依赖）
  → 产品方向：实时协作（先出 openspec 提案）
```
