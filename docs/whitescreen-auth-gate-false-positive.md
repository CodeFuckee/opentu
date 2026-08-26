# Bug 复盘：`[MemoryLog] 白屏检测: 画板组件未加载` 误报

> 摘要：登录门禁（`AuthGate`）在未登录时只渲染登录页、不挂载画板 DOM，
> 而白屏检测器不知道"画板被有意隐藏"，于是把这种正常状态误判为白屏并打日志。

## 1. 现象

控制台出现：

```
[MemoryLog] 白屏检测: 画板组件未加载
```

该日志来自 `apps/web/src/crash-logger.ts` 的白屏检测模块。触发时应用其实并没有白屏，
只是正处于"未登录"状态，显示了登录页而非画布工作台。

## 2. 触发条件

- 应用启动在根路径 `/`；
- `#root` 已经有内容（React 已挂载，例如渲染了登录门禁的登录页）；
- 页面中没有任何 `.plait-board-container`（画板容器）；
- **用户未登录**，`AuthGate` 故意显示登录页而不渲染画板。

满足这些条件后，白屏检测会先等待、再次确认后上报"画板组件未加载"。

## 3. 根因

项目最初是"打开即工作台"：页面加载后根路径必然渲染画板，因此白屏检测器使用了这样一个
简化假设——

> **根路径（`/`）下，只要 `#root` 有内容、却没有 `.plait-board-container`，就是白屏。**

随后项目接入了 Supabase 登录能力，新增了 `AuthGate`：未登录时它渲染登录/注册页
（`#root` 有内容），但完全不渲染画板。白屏检测器不了解"画板被有意隐藏"这一状态，
继续套用旧假设，于是在未登录场景下产生误报。代码位置：

- 白屏检测逻辑：`apps/web/src/crash-logger.ts` → `checkForWhitescreen()`
- 登录门禁：`apps/web/src/supabase/auth-gate.tsx`

## 4. 修复方案

### 4.1 让"画板是否被有意隐藏"成为白屏判定的显式输入

把"该不该上报画板未加载"的决策从 `crash-logger.ts` 里抽成一个**纯函数**，明确加入
`isBoardHidden` 维度，便于测试和复用：

`apps/web/src/utils/whitescreen-detector.ts`

```ts
export function shouldReportBoardMissing(state: {
  hasContent: boolean;
  hasPlaitBoard: boolean;
  pathname: string;
  isBoardHidden: boolean;
}): boolean {
  if (!state.hasContent) return false;                  // 属于"React 未渲染"分支
  if (state.hasPlaitBoard) return false;                // 画板在, 不是白屏
  if (state.isBoardHidden) return false;                // 画板被有意隐藏（AuthGate）
  if (state.pathname !== '/') return false;             // 非首页不强制画板
  return true;
}
```

只有当：已渲染内容 + 画板缺失 + 未被有意隐藏 + 位于根路径，四者同时成立时，
才判定为"画板组件未加载"。

### 4.2 AuthGate 用 DOM 标记自己"隐藏了画板"

登录门禁渲染的两个非画板状态都打上 `data-whitescreen-hidden="auth-gate"` 标记：

- 会话恢复中的加载态
- 未登录的登录/注册页

这样白屏检测器能通过 DOM 感知"画板此刻被有意隐藏"，从而跳过误报。

### 4.3 白屏检测器接入新的判定

`crash-logger.ts` 的 `checkForWhitescreen()` 改为读取 DOM 标记并调用纯函数：

- 先查 `data-whitescreen-hidden` 是否存在（AuthGate 隐藏画板中）；
- 用 `shouldReportBoardMissing` 判断是否上报；
- 二次确认（`setTimeout` 之后）同样重新检查隐藏标记，避免这段时间登录或跳转造成误报。

只有在"确实没有画板且没有隐藏标记"时，才 `console.error('[MemoryLog] 白屏检测: 画板组件未加载')`。

## 5. 测试

项目原先的 `apps/web` 没有 `test` 目标，本次一并补齐 vitest 测试基建：

- 新增 `apps/web/vitest.config.ts`；
- 在 `apps/web/project.json` 增加 `test` target（`@nx/vite:test`）。

### 5.1 复现测试

`apps/web/src/utils/whitescreen-detector.spec.ts` —— 覆盖原始误报场景：

- 已渲染内容 + 首页 + 画板缺失 + **未被隐藏** → 判定为白屏（对应原缺陷路径）；
- 已渲染内容 + 首页 + 画板缺失 + **被 AuthGate 隐藏** → 不判为白屏（修复目标）；
- 画板存在、未渲染内容、非首页等边界 → 均不误报。

### 5.2 运行结果

```
# 全量 web 测试
nx run web:test
NX   Successfully ran target test for project web

# 复现用单测
vitest run --root apps/web src/utils/whitescreen-detector.spec.ts
Test Files  1 passed
Tests       5 passed
```

同时：
- `nx run web:typecheck` ✅
- `nx run web:build-app` ✅

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/utils/whitescreen-detector.ts` | 新增：纯函数 `shouldReportBoardMissing` |
| `apps/web/src/utils/whitescreen-detector.spec.ts` | 新增：复现/回归单测 |
| `apps/web/src/crash-logger.ts` | 修改：白屏检测读取隐藏标记并走纯函数 |
| `apps/web/src/supabase/auth-gate.tsx` | 修改：登录门禁 DOM 打隐藏标记 |
| `apps/web/vitest.config.ts` | 新增：web vitest 配置 |
| `apps/web/project.json` | 修改：新增 `test` target |
| `apps/web/src/sw/cdn-fallback.spec.ts` | 修改：标注 `@vitest-environment node`（该文件使用 stream/fetch mock，需 node 环境） |

## 7. 经验教训

- **面向新能力的检测器要显式处理"状态被新能力改变"的情况。** 白屏检测原本假设"根路径必有画板"，
  接入登录门禁后该假设被打破，检测器没有跟随更新。
- **把判定逻辑做成纯函数**，把领域输入（这里 `isBoardHidden`）显式建模，比在副作用代码里
  堆 `if` 更易测试、更不易遗漏边界。
- **给 DOM 状态打语义化标记（`data-*`）** 让跨模块的观测者（监控/检测）能理解意图，是一种
  轻量、解耦的沟通方式。
