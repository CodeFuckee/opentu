# 功能说明：oa账号登录（自动拼接 @yjk.com）

## 1. 需求

登录/注册不再要求用户输入邮箱，而是输入 **oa账号**（小写）。
用户输入 oa账号后，前端自动拼接 `@yjk.com` 作为 Supabase GoTrue 的登录邮箱。

例如：

```
用户输入: zhangsan
实际邮箱: zhangsan@yjk.com
```

## 2. 为什么这样做

Supabase GoTrue（v2）的 `signInWithPassword` **只接受 email 或 phone**，
不支持任意字符串账号（实测 `email: 'notemail'` 会被拒为 invalid_credentials）。

因此采用「账号 = 邮箱前缀」方案：

- 用户侧只感知 oa账号；
- 前端 `normalizeLoginAccount()` 把输入拼成 `{oa账号}@yjk.com`；
- GoTrue 语义不变（仍用 email 登录），email 天然唯一；
- 复用 `user_profiles.oa_account` 字段存储 oa账号，无需新增表/字段/Edge Function。

## 3. 账号规范化规则

`apps/web/src/supabase/auth-validation.ts` → `normalizeLoginAccount(input)`

| 输入 | 输出 | 说明 |
|------|------|------|
| `zhangsan` | `zhangsan@yjk.com` | 拼接 `@yjk.com` |
| `ZhangSan` | `zhangsan@yjk.com` | 自动转小写 |
| `alice@example.com` | `alice@example.com` | 含 `@` 视为完整邮箱原样返回 |
| `  `（空白） | `''` | 空输入返回空 |

域名常量：`OA_EMAIL_DOMAIN = 'yjk.com'`（如需改域名，只改这一处）。

## 4. 登录 / 注册流程

### 登录
1. 用户输入 oa账号 + 密码；
2. 前端校验（账号必填、密码 ≥ 6 位）；
3. `signIn(account, password)` → normalize → `signInWithPassword({ email: 'xx@yjk.com', password })`；
4. 失败时调 `check-email` Edge Function（用拼接后 email）区分「账号未注册」与「密码错误」。

### 注册
1. 用户输入 oa账号 + 密码 + 确认密码；
2. `signUp(account, password)` → normalize → `auth.signUp({ email: 'xx@yjk.com', password })`；
3. 注册成功后，前端把 `{ user_id, oa_account: account }` upsert 到 `user_profiles`
   （RLS 的 insert/update own 策略允许用户写自己的行，`onConflict: 'user_id'`）；
4. 邮箱确认：本实例 `mailer_autoconfirm=true`，注册即登录。

## 5. 前端改动文件

| 文件 | 说明 |
|------|------|
| `apps/web/src/supabase/auth-validation.ts` | `normalizeLoginAccount`、账号校验、错误文案（oa账号或密码错误 / 该账号尚未注册） |
| `apps/web/src/supabase/auth-context.tsx` | `signUp/signIn` 内部 normalize；注册成功 `persistOaAccount()` 写 `user_profiles.oa_account` |
| `apps/web/src/supabase/auth-form.tsx` | 输入框 placeholder「oa账号（小写）」、`autocomplete="username"`、check-email 用拼接后 email |

## 6. 数据

`user_profiles.oa_account`（text）：存储 oa账号（如 `zhangsan`），登录邮箱为其拼接结果。

## 7. 边界与兼容

- **存量用户**：既有用户（如 `dsh_test@example.com`）用 `dsh_test` 登录会拼成
  `dsh_test@yjk.com` 而找不到——这是账号体系变更的预期行为。迁移方式：管理员在
  `user_profiles.oa_account` 填入其 oa账号（= 原邮箱 @ 前缀），之后即可按新规则登录。
- **输入含 `@`**：按完整邮箱处理（兼容直接输入邮箱的场景）。
- **大小写**：前端统一 `toLowerCase()`，避免大小写不一致导致「已注册但登不上」。

## 8. 测试

`apps/web/src/supabase/auth-validation.spec.ts`（16 用例）覆盖：

- `normalizeLoginAccount`：拼接、小写、含 @ 原样、空输入；
- `validateLoginInput`：空账号报错、非邮箱字符串放行、短密码报错；
- `validateSignUpInput`：两次密码不一致、短密码拦截、合法输入；
- 错误文案：该账号尚未注册 / oa账号或密码错误 / 该账号已注册。

端到端实测（真实后端）通过：

```
注册 e2e_oa_xxx        -> 创建 e2e_oa_xxx@yjk.com 用户，oa_account 写入 user_profiles
登录 e2e_oa_xxx + 密码 -> 成功（等效邮箱登录）
```

运行：`nx run web:test`、`nx run web:typecheck`、`nx run web:build-app` 全绿。
