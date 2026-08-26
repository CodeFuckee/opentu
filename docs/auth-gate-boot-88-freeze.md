# Bug 复盘：登录门禁导致页面卡在 88%「正在唤起工作台」

> 摘要：接入 Supabase 登录门禁（`AuthGate`）后，未登录时 `#root` 只渲染登录页、不再挂载
> `<App/>`。而启动过渡层（boot 覆盖层）只能靠 `<App/>` 内部调用的 `markReady()` 移除，
> 于是 `markReady()` 永远不会执行，页面永久停留在 bootstrap 最后阶段（88%）。

## 1. 现象

控制台不再有报错（上一轮白屏误报已修复），但页面打开后一直显示：

```
正在唤起工作台
进度 88%
```

永远不会进入登录页或工作区。

## 2. 触发条件

- 应用启动；
- 用户**未登录**（Supabase `AuthGate` 只渲染登录/注册页）；
- `AuthGate` 把 `<App/>`（工作区组件）**条件渲染**掉了，`<App/>` 根本没有挂载。

## 3. 根因

项目启动时的 "正在唤起工作台" 进度条是一个**独立于 React 的 boot 覆盖层**
（`index.html` 里的 `#app-boot-loading`）。它有且仅有一个隐藏入口——`window.__OPENTU_BOOT__.markReady()`。

在接入登录门禁之前，启动流程是：

```
启动 bundle -> setProgress(88%) -> root.render(<App/>)
   -> <App/> 内 useEffect: 当 !isLoading 时调用 markReady()  -> 覆盖层淡出
```

即 `markReady()` 被写死在 `<App/>` 的 `useEffect` 里（`apps/web/src/app/app.tsx`）。

接入 `AuthGate` 之后，根节点渲染变成了：

```
root.render(
  <AuthProvider>
    <AuthGate>
      <App/>          // 这是 AuthGate 的 children
    </AuthGate>
  </AuthProvider>
)
```

`AuthGate` 的逻辑是：已登录才渲染 `children`（`<App/>`），未登录只渲染登录页。

问题随之而来：

- **未登录**时 `AuthGate` 不渲染 `<App/>`，而 `markReady()` 只在 `<App/>` 内部被调用
  ⇒ `markReady()` 永远不会执行 ⇒ boot 覆盖层永远停留在 88%。
- 登录页虽然已经渲染在 `#root` 里，却被 88% 的 boot 覆盖层整个盖住，用户什么都看不见，
  看起来就像"卡死"。

## 4. 修复方案

让启动过渡层不再"只依赖 `<App/>`"，而是"只要应用渲染出了决定性界面（登录页或工作区）
就视为 ready"。

`apps/web/src/supabase/auth-gate.tsx` 中新增：

- 一个与 `app.tsx` 一致的 `getBootController()` 读取 `window.__OPENTU_BOOT__`；
- 一个 `useEffect`，在 `isReady`（会话已解析）后调用 `markReady()`：

```tsx
useEffect(() => {
  if (!isReady) {
    return;
  }
  getBootController()?.markReady();
}, [isReady]);
```

要点：

- 会话一旦就绪，无论结果登录还是未登录，页面都必然渲染出决定性界面，此刻即可关闭 boot 覆盖层。
- `markReady()` 在 `index.html` 里是**幂等**的（内部有 `if (bootReady) return`），已登录时
  `<App/>` 再调用一次也无副作用。
- `isReady=false` 时不调用，避免过早移除过渡层。

## 5. 测试

### 5.1 复现测试

`apps/web/src/supabase/auth-gate.spec.tsx`（新增），用 `@testing-library/react` 渲染
`AuthGate`，通过 `vi.mock` 注入可控的 `useAuth` 会话状态，并挂一个假的
`window.__OPENTU_BOOT__`，断言其 `markReady` 是否被调用：

- **未登录 + isReady** ⇒ 登录页已渲染，`markReady` 必须被调用（修复目标，修复前失败）；
- **已登录 + isReady** ⇒ 也标记 ready（修复前失败）；
- **isReady=false** ⇒ 尚未渲染决定性界面，不应调用（反向用例）。

### 5.2 复现到修复的过程

- 修复前运行：`2 failed / 1 passed`——两个 "should mark ready" 用例失败，正好复现 bug；
- 修复后运行：`3 passed`。

### 5.3 运行结果

```
# 全量 web 测试
nx run web:test
NX   Successfully ran target test for project web

# 单测
vitest run --root apps/web src/supabase/auth-gate.spec.tsx
Test Files  1 passed
Tests       3 passed
```

同时验证：
- `nx run web:typecheck` ✅
- `nx run web:build-app` ✅
- `eslint src/supabase` ✅

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/supabase/auth-gate.tsx` | 修改：会话就绪后调用 `markReady()`，妥善关闭 boot 覆盖层 |
| `apps/web/src/supabase/auth-gate.spec.tsx` | 新增：复现/回归单测 |

## 7. 经验教训

- **"启动就绪"信号不能写死在最终目标组件里。** 一旦引入门禁/鉴权等"条件渲染 children"的
  包装组件，最终组件可能不会挂载，就绪信号也会随之失效。就绪判定应放在"渲染出第一屏决定性
  界面"的层。
- **条件渲染会破坏隐式的生命周期契约。** `markReady()` 由 `<App/>` 触发，这个隐含假设在
  `AuthGate` 介入后被打破，属于"两处（唤醒点与隐藏点）耦合在不可见前提下"。
- **幂等的外部效果（`markReady`）可以安全地在多个层级冗余触发**，用来消除这类单点依赖。
