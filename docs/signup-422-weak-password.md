# Bug 复盘：注册时报 `POST /auth/v1/signup 422 (Unprocessable Entity)`

> 摘要：注册表单未做客户端校验，密码短于 GoTrue 最小长度（6 位）时直接请求后端，
> 后端返回 422 AuthWeakPasswordError，用户看到的是控制台 422 报错，而不是清晰的表单提示。

## 1. 现象

在注册弹窗输入邮箱和较短密码（如 5 位）点击"注册"后，控制台出现：

```
crash-logger.ts:1226
POST http://10.37.80.25:8021/auth/v1/signup 422 (Unprocessable Entity)
```

调用链：`auth-dialog.tsx`（提交表单）→ `auth-context.tsx`（`auth.signUp`）→ 后端 GoTrue。

## 2. 触发条件

- 打开注册弹窗；
- 输入的密码长度 **小于 6 位**（GoTrue 默认 `min_password_length = 6`）；
- 前端没有提前拦截，请求被发送到后端。

（邮箱格式非法会得到 400；密码过短得到 422；两者都属于"未做客户端校验就直接请求后端"。）

## 3. 根因

用实际安装的 `@supabase/supabase-js` 对同一后端复现：

```
password = "12345"  =>  error: { message: "Password should be at least 6 characters.",
                                 status: 422,
                                 name: "AuthWeakPasswordError" }
password = "123456" =>  成功注册
```

问题有两层：

1. **缺少客户端校验**：`AuthDialog.handleSubmit` 只检查了"邮箱非空、密码非空、两次密码一致"，
   没有校验密码长度（也没有校验邮箱格式）。短密码直接打到后端，触发 422。
2. **错误提示晦涩**：虽然 `getErrorMessage` 会把含 "password" 的错误映射成中文提示，
   但用户首先看到的是控制台里一条 422 网络报错；而且提示文案写死 "6 位以上"，
   与校验逻辑没有单一事实来源（hardcode 的 6 与 GoTrue 规则可能漂移）。

## 4. 修复方案

### 4.1 新增纯函数校验模块

`apps/web/src/supabase/auth-validation.ts`（新增），把校验逻辑抽成可单测的纯函数：

- `MIN_PASSWORD_LENGTH = 6`：与 GoTrue 默认最小长度一致的单一事实来源；
- `validateLoginInput(email, password)`：登录表单校验（必填、邮箱格式、密码长度）；
- `validateSignUpInput(email, password, confirm)`：注册表单校验（登录校验 + 两次密码一致）；
- `hasAuthErrors(errors)`：是否存在错误。

### 4.2 AuthDialog 提交前先本地校验

`apps/web/src/supabase/auth-dialog.tsx`（修改）：

- 提交时先调用 `validateSignUpInput` / `validateLoginInput`；
- 有错误则直接返回，**不再发送网络请求**（杜绝 422）；
- 错误以**字段级内联提示**展示（`.auth-field-error`，红色小字，全局样式已加到
  `apps/web/src/styles.scss`）；
- 密码输入框 placeholder 改为 `密码（至少 6 位）` 前置提示；
- 保留兜底：若仍有 422 之类的服务端错误（如密码规则后续变化），`getErrorMessage`
  对 `weak password` / `at least` 等文案给出明确中文提示，并统一引用 `MIN_PASSWORD_LENGTH`。

## 5. 测试

### 5.1 复现测试

`apps/web/src/supabase/auth-validation.spec.ts`（新增）：

- **REPRO**：密码 `12345`（5 位）注册时 `validateSignUpInput` 必须报"密码至少 6 位"，
  即本地拦截、不会走到后端 422；
- 密码恰好 6 位 → 放行；
- 两次密码不一致 → 拦截；
- 邮箱为空 / 格式非法 → 拦截；
- 登录表单同样校验短密码。

### 5.2 运行结果

```
# 单测
vitest run --root apps/web src/supabase/auth-validation.spec.ts
Test Files  1 passed
Tests       6 passed

# 全量 web 测试
nx run web:test
NX   Successfully ran target test for project web

# 其他验证
nx run web:typecheck ✅
nx run web:build-app   ✅
eslint src/supabase    ✅
```

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/supabase/auth-validation.ts` | 新增：认证表单校验纯函数（含 `MIN_PASSWORD_LENGTH`） |
| `apps/web/src/supabase/auth-validation.spec.ts` | 新增：复现/回归单测 |
| `apps/web/src/supabase/auth-dialog.tsx` | 修改：提交前本地校验 + 字段级错误提示 + 错误文案优化 |
| `apps/web/src/styles.scss` | 修改：新增 `.auth-field-error` 样式 |

## 7. 经验教训

- **表单类提交，先本地校验再请求后端。** 能提前拦截的（必填、格式、长度）绝不打网络请求，
  否则用户看到的是 422/400 这类无意义的 HTTP 报错。
- **业务约束要收敛到单一事实来源。** GoTrue 最小密码长度是 6，前端校验与提示文案都引用
  同一个 `MIN_PASSWORD_LENGTH` 常量，避免写死多处后漂移。
- **后端错误码（422）对最终用户没有信息量。** 即使服务端规则后续变化，也要把
  `AuthWeakPasswordError` 这类语义映射成用户能理解的中文提示。
