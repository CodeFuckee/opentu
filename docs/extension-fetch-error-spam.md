# Bug 复盘：登录后控制台刷出 1000+ 条 `Failed to fetch`（浏览器扩展注入错误）

> 摘要：登录进入工作区后控制台出现上千条
> `Uncaught (in promise) TypeError: Failed to fetch`，调用栈全部位于浏览器扩展
> 的脚本（`api.service.ts` / `background.js`）中，与项目代码无关。项目侧修复：
> 崩溃监控不再把第三方扩展错误当作项目崩溃记录，避免污染快照与放大日志。

## 1. 现象

登录后控制台刷出大量（1000+ 条）：

```
api.service.ts:1336  Uncaught (in promise) TypeError: Failed to fetch
    at qC.nativeFetch (api.service.ts:1336:12)
    at i (api.service.ts:1331:73)
    at qC.<anonymous> (api.service.ts:1332:12)
    at Generator.next (<anonymous>)
    at s (background.js:2:2469938)
```

## 2. 诊断：错误来自浏览器扩展，不是项目代码

### 2.1 全量源码排查

- 全仓库（`apps/`、`packages/`）搜索 `nativeFetch`、`api.service`、`background.js`：
  **零匹配**。项目里没有 `api.service.ts`，也没有 `background.js`。
- 项目 Service Worker 构建产物是 `sw.js`（`vite.sw.config.ts` 中 `fileName: () => 'sw.js'`），
  不叫 `background.js`。
- `index.html` 只加载项目自身脚本（bootstrap、PostHog），无第三方注入脚本。

### 2.2 错误栈分析

```
api.service.ts:1336  nativeFetch   ← 扩展自己封装的 fetch
api.service.ts:1331  i             ← 扩展的 API 客户端
api.service.ts:1332  <anonymous>
Generator.next                    ← 扩展的异步代码（压缩产物）
background.js:2:2469938           ← 扩展后台脚本（manifest background）
```

整个调用链**没有一帧属于项目代码**。`background.js:2:2469938` 中 `2` 是行号、
`2469938` 是列号，这是**压缩后的浏览器扩展代码**（Chrome 扩展的 background service
worker）。DevTools 的 Console 默认显示**所有上下文**（页面 + 扩展 background）的日志，
因此扩展自己的报错会出现在页面的控制台里。

### 2.3 为什么登录后出现

- 登录前，`AuthGate` 只渲染登录表单，页面活动很少；
- 登录成功后渲染工作区，页面开始大量初始化与网络活动（任务队列恢复、素材加载、
  AI 模型探测、Supabase 会话管理等）；
- 某些浏览器扩展（常见于翻译 / 划词 / AI 助手 / 代理类扩展）会随页面活动高频调用
  它自己的后端 API；当扩展后端不可达时，每次失败输出一条
  `Uncaught (in promise) TypeError: Failed to fetch`，于是累积成上千条。

### 2.4 项目侧被放大的问题

`apps/web/src/crash-logger.ts` 的全局错误捕获（`setupErrorCapture`）会通过
`unhandledrejection` 事件把**任何** rejection 都当作项目崩溃：
记录快照 → `sendSnapshotToSW` → `console.error('[MemoryLog] Unhandled rejection captured:', ...)`。

扩展注入的 `Failed to fetch` 也会被捕获，导致：
- 崩溃监控（SW / IndexedDB）被第三方扩展错误污染；
- 日志放大，与本问题叠加更难看。

## 3. 修复

### 3.1 新增纯函数：扩展错误识别

`apps/web/src/utils/extension-error-filter.ts`

- `isExtensionError(error, errorMessage?)`：根据**错误栈**和**错误消息**判断错误是否来自
  浏览器扩展。
- 栈特征：`background.js`、`chrome-extension://`、`moz-extension://`、
  `safari-extension://`、`nativeFetch`、`api.service` 等；
- 消息特征：`Extension context invalidated`、`The message port closed...`、
  `Could not establish connection. Receiving end does not exist` 等。

### 3.2 crash-logger 接入过滤

`apps/web/src/crash-logger.ts`

- `unhandledrejection` 处理器：在记录快照前先 `isExtensionError` 判断，是则**直接返回**；
- `error` 处理器：同样先过滤扩展错误；
- 与既有的 PostHog 网络错误过滤（同函数内已有先例）保持同一模式。

这样，扩展错误不再进入项目崩溃快照、不再触发 `[MemoryLog] Unhandled rejection captured` 日志。

### 3.3 无法修复的部分

- 扩展 background 脚本在 DevTools Console 里的原始报错**无法被任何网页代码消除**
  （独立上下文）。要彻底消除控制台刷屏，需在浏览器中定位并处理该扩展：
  - DevTools → Console 右上角切换上下文，查看报错属于哪个扩展；
  - 或 `chrome://extensions` 逐个禁用排查；
  - 或对目标扩展在其设置中关闭与本站相关的自动功能。

## 4. 测试

### 4.1 复现 / 回归测试

`apps/web/src/utils/extension-error-filter.spec.ts`（6 个用例）：

- **REPRO**：构造 `TypeError: Failed to fetch`，栈为 `api.service.ts:1336` +
  `background.js:2:2469938`（与用户控制台报错完全一致）→ 判定为扩展错误；
- 栈含 `chrome-extension://` → 判定为扩展错误；
- 消息含 `Extension context invalidated` → 判定为扩展错误；
- 项目自身错误（栈为 `app.tsx` / `main.tsx`）→ 不误判；
- 无栈信息的普通错误 → 不误判；
- 非 Error 的 rejection reason（字符串 / undefined / null）→ 安全处理。

### 4.2 运行结果

```
# 单测
vitest run --root apps/web src/utils/extension-error-filter.spec.ts
Test Files  1 passed
Tests       6 passed

# 全量 web 测试
nx run web:test            ✅
nx run web:typecheck       ✅
nx run web:build-app       ✅
eslint（新增文件）          ✅
```

说明：`crash-logger.ts` 全文件的 18 个 `no-restricted-globals`（location 等）lint error
为改动前已存在，与本次修改无关（已用 git stash 验证）。

## 5. 涉及文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/utils/extension-error-filter.ts` | 新增：`isExtensionError` 纯函数 |
| `apps/web/src/utils/extension-error-filter.spec.ts` | 新增：复现/回归单测 |
| `apps/web/src/crash-logger.ts` | 修改：`error` / `unhandledrejection` 捕获前过滤扩展错误 |

## 6. 经验教训

- **控制台里不全是"你的代码"**：浏览器扩展的 background / content script 报错会出现在
  页面控制台。先看调用栈是否包含项目文件，再决定是否属于本项目 bug。
- **全局错误捕获要区分"自己"与"外部"**：`unhandledrejection` 会收到所有 rejection，
  包括扩展注入的；不加过滤会把第三方错误写进崩溃监控，污染数据、放大日志。
  与 PostHog 网络错误一样，扩展错误也应静默忽略。
- **Stack trace 是分类器**：`background.js`、`chrome-extension://`、压缩产物的大列号
  （如 `2:2469938`）都是扩展特征，可作为过滤依据。
