# 功能说明：登录时区分「邮箱未注册」与「密码错误」

> 需求：登录时如果邮箱没有注册，应提示"该邮箱尚未注册，请先注册"，
> 而不是笼统的"邮箱或密码错误"。

## 1. 为什么默认做不到

Supabase Auth（GoTrue）出于**防枚举（anti-enumeration）安全设计**，
对以下场景返回**完全相同**的错误响应：

| 场景 | 状态码 | error.code | error.message |
|---|---|---|---|
| 邮箱未注册 | 400 | `invalid_credentials` | `Invalid login credentials` |
| 邮箱已注册 + 密码错误 | 400 | `invalid_credentials` | `Invalid login credentials` |

实测确认（本仓库后端 `http://10.37.80.25:8021`）：

- `signInWithPassword`：两种情况都是 `invalid_credentials`（400），前端无法区分。
- `/auth/v1/recover`（忘记密码）：两种情况都返回 200，无法区分。
- `signInWithOtp`（magic link）：两种情况都返回 `otp_disabled`（422），无法区分
  （且该实例邮件服务未配置，OTP 不可用）。
- `signUp` 探测：已注册 → `user_already_exists`（422）；未注册 → **会真的创建用户**
  （幽灵账户副作用，不可接受）。
- Admin API `GET /auth/v1/admin/users`：**可以精确区分**，但需要 **service_role key**。

## 2. 方案：后端 Edge Function + Admin API

采用「后端查询 + 前端提示」的两段式方案：

1. **Edge Function `check-email`**（`supabase/functions/check-email/`）：
   - 使用 `SERVICE_ROLE_KEY`（仅存在于函数环境变量，**绝不进入前端 bundle**）
   - 调用 GoTrue Admin API：`GET /auth/v1/admin/users?filter=email=eq.<email>&per_page=1`
   - 返回 `{ "registered": true | false }`
2. **前端登录流程**（`apps/web/src/supabase/`）：
   - `signInWithPassword` 失败（`invalid_credentials`）后，调用
     `POST /functions/v1/check-email` 查询该邮箱是否注册
   - 未注册 → 提示「该邮箱尚未注册，请先注册」
   - 已注册 / 查询失败 → 回退通用提示「邮箱或密码错误」（查询失败不阻塞登录）

### 安全性

- service_role key 只存在于 Supabase 侧环境变量，前端永远拿不到；
- 前端调用的函数 URL 是公开入口，函数内部鉴权由 `SERVICE_ROLE_KEY` 完成；
- 未注册邮箱**不会被创建**（无幽灵账户副作用），与 `signUp` 探测方案相比是本质区别。

## 3. 部署（私有化 Supabase）

### 本实例实际部署情况（已执行完成）

- **服务器**：`10.37.80.25`，SSH 免密：`ssh mdc@10.37.80.25`
- **函数目录**：`/home/mdc/codes/supabase/volumes/functions`（docker 挂载到容器内 `/home/deno/functions`）
- **函数运行时**：`supabase/edge-runtime:v1.74.0` 容器 `supabase-edge-functions`；
  该实例使用自定义 `main` 入口按请求路径动态加载 `/home/deno/functions/{name}`，**放好目录即可生效，无需重启容器**
- **环境变量**（容器内已配置，函数直接读取）：
  - `SUPABASE_SERVICE_ROLE_KEY`（注意名字是 `SUPABASE_SERVICE_ROLE_KEY`，不是 `SERVICE_ROLE_KEY`）
  - `SUPABASE_URL=http://api-gw:8000`（容器内网网关地址）

部署步骤（已完成）：
```bash
# 1. 在服务器创建函数目录
ssh mdc@10.37.80.25 "mkdir -p /home/mdc/codes/supabase/volumes/functions/check-email"

# 2. 上传函数文件（index.ts + core.ts）
scp supabase/functions/check-email/index.ts supabase/functions/check-email/core.ts \
  mdc@10.37.80.25:/home/mdc/codes/supabase/volumes/functions/check-email/

# 3. 通过网关验证（注意：网关在 8021，不是 8000；8000 上跑的是另一套 Django 服务）
curl -X POST http://10.37.80.25:8021/functions/v1/check-email \
  -H 'Content-Type: application/json' \
  -d '{"email":"someone@example.com"}'
# => {"registered": true|false}
```

实测结果（已通过）：
```
POST /functions/v1/check-email {"email":"e2e_99551@example.com"}        => 200 {"registered":true}
POST /functions/v1/check-email {"email":"definitely_nonexistent_999@example.com"} => 200 {"registered":false}
```

### 通用部署说明（其他自托管实例）

**方式 A：直接把函数放入服务器函数目录（自托管最常用）**
1. 将 `supabase/functions/check-email/` 目录整体复制到服务器 Supabase 项目的函数目录
   （docker-compose 里 `functions` 容器的挂载点，通常是 `./supabase/functions:/home/deno/functions`）。
2. 为函数配置环境变量（按实例实际命名，可能是 `SERVICE_ROLE_KEY` 或
   `SUPABASE_SERVICE_ROLE_KEY`）：
   - `<SERVICE_ROLE_KEY_ENV>=<service_role_key>`
   - `SUPABASE_URL=<网关地址>`
3. 若实例使用静态加载：重启函数容器 `docker compose restart functions`；
   若使用动态加载入口（如本实例的 `main`）：放好目录即生效。
4. 验证：`curl -X POST <网关>/functions/v1/check-email -H 'Content-Type: application/json' -d '{"email":"someone@example.com"}'`

**方式 B：supabase CLI 部署**
```bash
supabase link --project-ref <project-ref>   # 自托管需配置 SUPABASE_ACCESS_TOKEN
supabase secrets set SERVICE_ROLE_KEY=<key> SUPABASE_URL=<网关地址>
supabase functions deploy check-email
```

### 本实例探测要点（踩坑记录）

- `http://10.37.80.25:8021` 是 Kong 网关（前端访问入口）；
  `localhost:8000` / `api-gw:8000` 是容器内网地址，不要混用。
- 该实例 GoTrue **`filter` 参数不生效**（`GET /auth/v1/admin/users?filter=email=eq.x` 返回空），
  因此函数改为**拉取用户列表后在本地匹配邮箱**（自托管用户量小，per_page=1000 足够）。
- admin 端点：`GET /auth/v1/admin/users`（返回 `{ users: [...] }` 对象，不是裸数组），
  anon key 访问返回 403，service_role key 访问返回 200。

## 4. 前端代码改动

| 文件 | 说明 |
|------|------|
| `apps/web/src/supabase/auth-validation.ts` | 新增 `getLoginErrorMessage(error, registered)` 与 `getRawAuthErrorMessage(error)`；`registered===false` 时提示「该邮箱尚未注册，请先注册」，否则回退通用映射 |
| `apps/web/src/supabase/auth-context.tsx` | 新增 `checkEmailRegistered(email)`：调用 `functions.invoke('check-email')`，失败返回 `null` |
| `apps/web/src/supabase/auth-dialog.tsx` | 登录失败时先 `checkEmailRegistered` 再 `getLoginErrorMessage` 决定提示文案 |

## 5. 测试

### 5.1 前端单测（web vitest）

`apps/web/src/supabase/auth-validation.spec.ts` 新增用例：

- REPRO：旧的 `getRawAuthErrorMessage` 对 `invalid_credentials` 只能返回
  「邮箱或密码错误」（无法区分）；
- FIXED：`getLoginErrorMessage(err, false)` → 「该邮箱尚未注册，请先注册」；
- 已注册但密码错误（`registered=true`）→ 仍提示「邮箱或密码错误」；
- 查询失败（`registered=null`）→ 回退通用提示，不阻塞登录。

### 5.2 Edge Function 单测（node:test）

`supabase/functions/check-email/core.test.ts`（8 个用例，mock fetch）：

- `buildAdminUrl` 拼接 `/auth/v1/admin/users?filter=email=eq.<email>&per_page=1`；
- 已注册邮箱 → `registered: true`；未注册 → `registered: false`；
- Admin API 非 200 → 500 + 错误信息；
- 缺 `SERVICE_ROLE_KEY` → 500；
- 非 POST → 405；邮箱缺失/非法 → 400。

运行：

```bash
# 前端测试
nx run web:test

# Edge Function 测试
node --test supabase/functions/check-email/core.test.ts
```

### 5.3 端到端实测（真实 service_role key + 已部署函数）

使用用户提供的 service_role key，在本地跑 `handleCheckEmail` 直接调用真实
admin API，以及部署后通过网关调用，结果一致：

| 邮箱 | 本地逻辑 | 网关部署后 |
|---|---|---|
| `e2e_99551@example.com`（已注册） | `{"registered":true}` | `{"registered":true}` |
| `definitely_nonexistent_999@example.com`（未注册） | `{"registered":false}` | `{"registered":false}` |

### 5.4 测试发现并修复的真实 bug

1. Edge Function 首版 `new URL('/users', base)` 以 `/` 开头会**替换整个路径**，
   导致 admin 查询打到 `…/users` 而非 `…/auth/v1/admin/users`。单测第一时间捕获，已修复。
2. 实测发现该实例 GoTrue **`filter` 参数不生效**（返回空列表），函数改为
   **拉取用户列表后本地匹配邮箱**（大小写不敏感），单测同步覆盖。

## 6. 涉及文件

| 文件 | 说明 |
|------|------|
| `supabase/functions/check-email/index.ts` | Edge Function 入口（Deno.serve + 环境变量） |
| `supabase/functions/check-email/core.ts` | 核心逻辑（无 Deno 依赖，可单测） |
| `supabase/functions/check-email/core.test.ts` | Edge Function 单测（node:test） |
| `apps/web/src/supabase/auth-validation.ts` | 登录错误提示纯函数 |
| `apps/web/src/supabase/auth-validation.spec.ts` | 前端单测（含 REPRO/FIXED 用例） |
| `apps/web/src/supabase/auth-context.tsx` | `checkEmailRegistered` 调用 Edge Function |
| `apps/web/src/supabase/auth-dialog.tsx` | 登录失败后区分提示 |

## 7. 经验教训

- **GoTrue 防枚举是刻意的**：把"邮箱未注册"和"密码错误"设计成相同响应，防止攻击者
  枚举有效邮箱。要区分就得换通道（Admin API / 数据库），而不是改前端逻辑。
- **任何"探测邮箱是否存在"的手段都要警惕副作用**：`signUp` 探测会真的创建用户，
  产生幽灵账户；`recover`/`otp` 不区分。Admin API 是唯一零副作用、精确的方案。
- **service_role key 永不进前端**：即使自托管内网，也应通过后端/边缘函数持有，
  前端只调公开函数 URL。
- **URL 拼接用 `new URL` 时注意以 `/` 开头的 path 会替换 base 路径**，单测覆盖 URL
  结构能提前发现这类问题。
