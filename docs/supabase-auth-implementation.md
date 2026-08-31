# Supabase 用户注册 / 登录接入指南（可跨平台复用）

> 本文档由 **Yue画布（opentu）** 项目的真实实现提炼而成，目标是让任何平台
> （Web / Vue / 小程序 / 移动端 / 后端服务）都能快速接入 Supabase 邮箱 + 密码
> 注册登录，并覆盖三个现实问题：
>
> 1. **账号体系**：让用户用「简短账号」而非完整邮箱登录（账号自动映射为邮箱）；
> 2. **防枚举**：登录失败时区分「账号未注册」与「密码错误」（GoTrue 默认两者返回相同错误）；
> 3. **白名单注册**：只允许名单内人员注册，注册后自动初始化用户资料与第三方平台账号。
>
> 项目真实实现位置：`apps/web/src/supabase/`（前端）、`supabase/functions/`（Edge Functions）、
> `supabase/migrations/`（数据库）。专项文档：`docs/oa-account-login.md`、
> `docs/check-email-registered-login-hint.md`、`docs/supabase-keys.md`。

---

## 1. 整体架构

```
┌────────────────────────────── 前端（任意平台） ──────────────────────────────┐
│                                                                              │
│  AuthProvider（会话状态机）                                                  │
│    ├─ getSession() / onAuthStateChange()  ── 恢复会话 + 订阅变更             │
│    ├─ signUp()   → auth.signUp({ email, password })                          │
│    ├─ signIn()   → auth.signInWithPassword({ email, password })              │
│    └─ signOut()  → auth.signOut()                                            │
│                                                                              │
│  AuthGate（会话门禁）                                                        │
│    ├─ 会话未知 → 加载态                                                      │
│    ├─ 未登录   → 渲染登录/注册表单                                            │
│    └─ 已登录   → 渲染业务界面                                                 │
│                                                                              │
│  AuthForm（表单 + 前端校验 + 错误文案）                                       │
│    ├─ 登录失败 → GET functions/v1/check-email    → 区分「未注册」vs「密码错」│
│    └─ 注册前   → POST functions/v1/check-register → 白名单资格校验           │
└─────────────────────────────────────────────────┬────────────────────────────┘
                                                  │ anon key（公钥，可进前端 bundle）
                                                  ▼
┌────────────────────── Supabase（自托管或云托管） ────────────────────────────┐
│  GoTrue Auth：GET/POST /auth/v1/*（注册/登录/会话/刷新令牌）                 │
│  PostgREST：   /rest/v1/*（业务表，RLS 按 auth.uid() 控制行权限）            │
│  Edge Functions：/functions/v1/*（持有 service_role key，绕过 RLS 做特权操作）│
│  Postgres + RLS：user_profiles / staff_directory / departments（见 §6）       │
└──────────────────────────────────────────────────────────────────────────────┘
```

**关键分层原则**：

- **anon key**（公钥）进前端：仅用于发起认证请求（GoTrue 的注册/登录入口本身就是公开的）。
- **service_role key**（私钥）绝不进前端：只存在于 Edge Function 环境变量 / 后端服务，
  用于 Admin API 查询用户、读白名单表、写用户扩展资料等特权操作。
- **RLS 兜底**：即使用户绕过前端直接 PostgREST，也读不到别人的数据、写不进别人的行。

---

## 2. 前置准备（Supabase 项目配置）

| 项 | 说明 | 本项目取值示例 |
|---|---|---|
| SUPABASE_URL | 项目网关地址（云托管为 `https://<ref>.supabase.co`） | `http://10.37.80.25:8021` |
| ANON KEY | 公钥，浏览器端鉴权入口使用 | JWT，role=anon |
| SERVICE_ROLE KEY | 私钥，仅后端/函数持有 | JWT，role=service_role |
| `mailer_autoconfirm` | 注册后免邮件确认直接登录（内网/白名单场景推荐） | `true` |
| 最小密码长度 | GoTrue 默认 6 位，前端校验需一致否则 422 | 6 |

> 自托管实例下，云 Studio 中的 `apikey anon` / `service_role` 在
> **Settings → API** 查看；容器内环境变量命名注意是 `SUPABASE_SERVICE_ROLE_KEY`。

### 2.1 环境变量（前端）

```env
# apps/web/.env（Vite 项目示例；其他框架原理相同）
VITE_SUPABASE_URL=http://10.37.80.25:8021
VITE_SUPABASE_ANON_KEY=eyJhbGci...
```

前端客户端创建（`apps/web/src/supabase/supabase-client.ts`）：

```ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL =
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '<默认值>';
const SUPABASE_ANON_KEY =
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || '<默认值>';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,      // 会话持久化到 localStorage（刷新不掉线）
        autoRefreshToken: true,    // 自动刷新 access_token（默认 1 小时过期）
        detectSessionInUrl: true,  // 识别 URL 中的认证回调（如 magic link）
      },
    });
  }
  return client;
}
```

---

## 3. 核心模式（与平台无关，任何技术栈都适用）

### 3.1 账号体系设计：账号 ↔ 邮箱映射

GoTrue 的 `signInWithPassword` **只接受 email 或 phone**，不接受任意字符串账号。
如果业务想用「工号 / 账号简称」登录，采用**邮箱前缀映射**方案：

```
用户输入: zhangsan
实际邮箱: zhangsan@yjk.com      （前端统一 trim + toLowerCase 后拼接 @<域名>）
输入含 @ : 视为完整邮箱原样返回  （兼容直接输入邮箱的用户）
```

通用实现（TypeScript；任何语言等价）：

```ts
const OA_EMAIL_DOMAIN = 'yjk.com'; // 改域名只改这一处

export function normalizeLoginAccount(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed;
  return `${trimmed}@${OA_EMAIL_DOMAIN}`;
}
```

要点：

- **email 天然唯一**，无需单独建账号唯一索引；
- 前端的注册/登录表单提示用户输入「账号」，展示层与 GoTrue 的 email 语义解耦；
- 所有 normalize 必须在**前端**完成（后端 GoTrue 只认 email）；
- 端到端一致性：注册时拼成什么邮箱，登录时也必须拼成同样邮箱（保持大小写折叠一致）。

### 3.2 认证状态机

```
state: 'unknown' ──getSession() 完成──► 'authenticated' | 'unauthenticated'
        ▲                                      │
        └────────────── onAuthStateChange ─────┘
        （登录/登出/令牌刷新/会话过期都会触发，UI 无需手动刷新）
```

- 启动时 `getSession()` 恢复会话（localStorage 中持久化）；
- 之后用 `onAuthStateChange` 订阅，任何认证事件自动驱动 UI；
- `unknown` 状态必须单独渲染**加载态**（不要闪现登录页），否则刷新时 UI 闪烁。

### 3.3 会话门禁（Gate）

```tsx
// 未就绪 → 加载态；未登录 → 表单；已登录 → children（业务界面）
if (!isReady) return <Loading>正在恢复登录状态...</Loading>;
return isAuthenticated ? children : <AuthForm />;
```

- 门禁只做「会话已就绪与否」的判断，**不在这里发起任何网络请求**；
- 页面启动加载动画由门禁在 `isReady` 时关闭（幂等），避免未挂载业务界面时启动动画卡死。

### 3.4 防枚举：区分「账号未注册」与「密码错误」

GoTrue 出于防枚举安全设计，对「未注册」和「密码错误」返回**完全相同**的
`400 invalid_credentials`。业务上要友好提示，必须换通道探测：

| 探测手段 | 结果 | 副作用 |
|---|---|---|
| `signInWithPassword` | 两者相同错误 | 无 |
| `auth.recover`（忘记密码） | 两者均 200 | 无法区分 |
| `auth.signInWithOtp` | 均 `otp_disabled`/邮件未配则不可用 | 无法区分 |
| `auth.signUp` 探测 | 已注册 `user_already_exists` | **未注册会真的创建用户（幽灵账户），不可接受** |
| **Admin API `/auth/v1/admin/users`** | **可精确区分** | **零副作用，需 service_role** |

因此用 **Edge Function `check-email`** 封装 Admin API：

```ts
// 请求: POST /functions/v1/check-email  { "email": "zhangsan@yjk.com" }
// 响应: 200 { "registered": true | false }
const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'GET',
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: 'application/json',
  },
});
// 自托管实例可能忽略 filter 参数 → 拉全量列表后本地匹配（大小写不敏感）
const { users } = await response.json();
const registered = users.some(u => u.email?.toLowerCase() === email.toLowerCase());
```

前端登录失败后调用：

```ts
const { error } = await auth.signInWithPassword({ email, password });
if (error) {
  const registered = await invokeCheckEmail(email); // false → 未注册
  message(registered === false ? '该账号尚未注册，请先注册' : '账号或密码错误');
  // registered === null（函数不可用）→ 回退通用提示，不阻塞登录
}
```

> 安全取舍：该探测接口暴露了邮箱是否注册的信息。白名单场景（§3.5）下，
> 未注册用户本就要被引导去注册，此信息泄露可接受；对公开注册的站点，
> 可自行评估是否保留该提示。

### 3.5 白名单注册：只允许名单内人员注册

注册前先调 Edge Function `check-register` 校验资格：

```
1. 账号不在 staff_directory 表         → { eligible:false, reason:'not-staff' }
2. 在表里，但其部门 enabled=false      → { eligible:false, reason:'department-disabled' }
3. 在表里且部门启用                    → { eligible:true }
```

实现要点：

- `staff_directory`（人员花名册）表**开启 RLS 且不建任何 anon/authenticated 策略，
  显式 revoke 其表级权限** → 前端无法直接读表单，只有 service_role 能访问；
  否则花名册（姓名/账号）会被任意人 PostgREST 枚举。
- Edge Function 用 service_role key 经 PostgREST 查询即可（无需 admin API）。
- 前端「查询失败（null）」时**放行注册**（不阻塞），避免函数故障导致无人能注册。

### 3.6 注册后的置后任务（fire-and-forget）

注册成功后，业务常有「初始化用户资料」「创建第三方平台账号」等需求。
**不要**在注册请求的同步路径里等这些任务完成，全部 fire-and-forget：

```ts
const { data, error } = await auth.signUp({ email, password });
if (!error && data.user) {
  void syncStaffProfile(data.user.id, account);   // 按白名单表填 user_profiles
  void requestThirdPartyAccount(data.user.id, account); // 第三方联动
}
// 失败仅 console.warn，绝不阻塞注册成功
```

这样注册接口的延迟、第三方平台故障都不会影响用户注册体验。

---

## 4. 前端参考实现（React；其他框架映射见 §7）

文件都在 `apps/web/src/supabase/`，结构与职责如下：

| 文件 | 职责 | 纯函数可单测 |
|---|---|---|
| `supabase-client.ts` | 创建/复用 Supabase 客户端（单例） | — |
| `auth-context.tsx` | 认证状态机 + signUp/signIn/signOut + Edge Function 调用 | — |
| `auth-validation.ts` | 表单校验 / 账号 normalize / 错误文案映射（**纯函数**） | ✅ |
| `auth-gate.tsx` | 会话门禁（加载态 / 表单 / 业务界面） | — |
| `auth-form.tsx` | 登录/注册表单 UI | — |
| `user-menu.tsx` | 已登录用户入口 + 退出登录 | — |
| `user-avatar.ts` | 首字符头像（display name → 邮箱首字符） | ✅ |

### 4.1 AuthContext（状态机核心）

```tsx
type AuthStatus =
  | { state: 'unknown' }
  | { state: 'authenticated'; session: Session; user: User }
  | { state: 'unauthenticated' };

useEffect(() => {
  const client = getSupabaseClient();

  // 1. 启动恢复会话
  client.auth.getSession().then(({ data, error }) => {
    setStatus(data.session?.user
      ? { state: 'authenticated', session: data.session, user: data.session.user }
      : { state: 'unauthenticated' });
  });

  // 2. 订阅认证事件（登录/登出/刷新自动同步）
  const { data: { subscription } } =
    client.auth.onAuthStateChange((_event, session) => {
      setStatus(session?.user
        ? { state: 'authenticated', session, user: session.user }
        : { state: 'unauthenticated' });
    });

  return () => subscription.unsubscribe();
}, []);
```

### 4.2 校验与错误文案（纯函数，易移植）

```ts
export const MIN_PASSWORD_LENGTH = 6; // 与 GoTrue 默认一致，避免 422

export function validateLoginInput(account: string, password: string) {
  const errors: Record<string, string> = {};
  if (!account.trim()) errors.account = '请输入账号';
  if (!password) errors.password = '请输入密码';
  else if (password.length < MIN_PASSWORD_LENGTH)
    errors.password = `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  return errors;
}

// GoTrue 常见错误 → 友好中文文案（用关键词匹配，注意 GoTrue 各版本措辞略有差异）
export function getRawAuthErrorMessage(error: Error | null): string {
  if (!error) return '';
  const lower = error.message.toLowerCase();
  if (lower.includes('invalid login')) return '账号或密码错误';
  if (lower.includes('already registered')) return '该账号已注册';
  if (lower.includes('weak password') || lower.includes('at least'))
    return `密码设置不合规，请至少使用 ${MIN_PASSWORD_LENGTH} 位以上`;
  if (lower.includes('email')) return '请输入有效的账号或邮箱';
  return error.message || '操作失败，请稍后重试';
}
```

### 4.3 已登录用户入口

- 头像：优先 `user_metadata` 中的 display name（`full_name`/`display_name`/`name`/`nickname`…）
  首字符，否则邮箱首字符（见 `user-avatar.ts`）；
- 悬浮显示完整邮箱；点击弹出「退出登录」；
- 登录状态变化由 AuthContext 统一驱动，业务侧只需读 `user`。

---

## 5. 后端 Edge Functions（Deno；可等价移植到 Node/Python/Go/任何后端）

**统一结构**：`index.ts`（Deno.serve + 读环境变量，薄壳）＋ `core.ts`（纯逻辑，无
Deno/框架依赖，可用 `node --test` 直接单测）＋ `core.test.ts`。

| 函数 | 调用时机 | 用途 | 持有密钥 |
|---|---|---|---|
| `check-email` | 登录失败后 | 查询邮箱是否注册（Admin API） | service_role |
| `check-register` | 注册提交前 | 白名单 + 部门开关资格校验 | service_role |
| `sync-staff-profile` | 注册成功后 | 按白名单表填 `user_profiles` + `auth.users` 元数据 | service_role |
| `newapi-key` | 注册成功后 | 第三方平台（new-api）账号自动开通（扩展示例） | service_role |

> 这四个函数的核心（`core.ts`）均为「纯 fetch + 参数校验」，**不绑定 Deno**：
> 在 Node/Python 后端里就是普通 HTTP handler；在无函数环境时，也可以写成
> 内部服务接口（§7.4）。

### 5.1 通用 Edge Function 骨架（check-email 示例）

```ts
// index.ts
import { handleCheckEmail } from './core.ts';

Deno.serve(async (request: Request) =>
  handleCheckEmail(request, {
    SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
  })
);

// core.ts（纯逻辑，可单测）
export async function handleCheckEmail(
  request: Request,
  env: { SERVICE_ROLE_KEY?: string; SUPABASE_URL?: string },
  deps: { fetch?: typeof fetch } = {}
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const key = env.SERVICE_ROLE_KEY || '';
  if (!key) return json(500, { error: 'SERVICE_ROLE_KEY not configured' });

  const { email } = await request.json().catch(() => ({}));
  if (typeof email !== 'string' || !email.includes('@'))
    return json(400, { error: 'email is required and must be valid' });

  // Admin API 拉全量 → 本地匹配（自托管实例 filter 常不生效，见 §10）
  const res = await (deps.fetch || fetch)(
    `${env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!res.ok) return json(500, { error: 'Admin API failed' });
  const { users } = await res.json();
  const registered = (users ?? []).some(
    (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
  );
  return json(200, { registered });
}
```

### 5.2 service_role 访问 PostgREST 的通用写法

所有函数里访问业务表（白名单、user_profiles、configs）都用同一模式：
**GET/POST 到 `/rest/v1/<表>`，头里带 `apikey` + `Authorization: Bearer <service_role>`**。
RLS 对 service_role 默认绕过，因此无需用户 JWT。

```ts
// 读：按字段过滤
const url = `${supabaseUrl}/rest/v1/staff_directory?oa_account=eq.${encodeURIComponent(oa)}&select=department,region&limit=1`;

// 写：upsert（on_conflict 指定唯一键 + Prefer 合并，等价 ON CONFLICT ... DO UPDATE）
const url = `${supabaseUrl}/rest/v1/user_profiles?on_conflict=user_id`;
await fetch(url, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates', // 冲突时合并（更新已存在行）
  },
  body: JSON.stringify({ user_id: userId, department, oa_account }),
});
```

---

## 6. 数据库与 RLS（迁移文件在 `supabase/migrations/`）

### 6.1 `user_profiles`（用户扩展资料，与 auth.users 一对一）

```sql
create table if not exists public.user_profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  department text, oa_account text, apikey text, region text, position text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS：用户只能读写自己的行
alter table public.user_profiles enable row level security;
create policy "user_profiles_select_own" on public.user_profiles
  for select using (auth.uid() = user_id);
create policy "user_profiles_insert_own" on public.user_profiles
  for insert with check (auth.uid() = user_id);
create policy "user_profiles_update_own" on public.user_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- ...（delete 同 select）
grant select, insert, update, delete on public.user_profiles to anon, authenticated;
```

### 6.2 `staff_directory`（注册白名单 / 人员花名册，敏感）

```sql
create table if not exists public.staff_directory (
  id bigint generated always as identity primary key,
  department text not null, region text not null,
  position text not null, name text not null,
  oa_account text not null unique,          -- 注册匹配键
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.staff_directory enable row level security; -- 不建任何 anon/authenticated 策略
revoke all on public.staff_directory from anon, authenticated; -- 自托管默认授权 ALL，必须显式收回
grant all on public.staff_directory to service_role;          -- 仅 service_role（绕过 RLS）
```

> **这是防花名册泄露的关键**：表开启 RLS + 无用户策略 + revoke 权限三步缺一不可。
> 用户要查看自己部门等字段，走 `user_profiles`（注册时已由函数复制过去）。

### 6.3 `departments`（部门清单 + 开关）

```sql
-- anon/authenticated 可 SELECT（登录前注册页要加载部门下拉）
create policy "departments_select_all" on public.departments
  for select to anon, authenticated using (true);
-- 写权限仅 service_role
revoke insert, update, delete on public.departments from anon, authenticated;
grant all on public.departments to service_role;
```

### 6.4 权限矩阵

| 表 | anon/authenticated | service_role |
|---|---|---|
| `user_profiles` | 仅自己的行（RLS） | 全量（绕过 RLS） |
| `staff_directory` | **不可读**（防枚举花名册） | 全量 |
| `departments` | 只读（注册页需要） | 全量 |

> 自托管 Supabase 默认会给 public 新表授予 anon/authenticated ALL 权限，
> **每个业务表都必须显式 revoke 收紧**，否则 RLS 形同虚设。

---

## 7. 在其他平台实现的移植清单

### 7.1 通用 API 对照（不依赖框架）

| 能力 | React（本项目） | Vue / 小程序 / Flutter / 其他 |
|---|---|---|
| 客户端初始化 | `createClient(url, anon, {auth})` | 官方 SDK 等价调用 |
| 注册 | `auth.signUp({email, password})` | 同 SDK 方法 |
| 登录 | `auth.signInWithPassword(...)` | 同 SDK 方法 |
| 退出 | `auth.signOut()` | 同 SDK 方法 |
| 恢复会话 | `auth.getSession()` | 同 SDK；无 SDK 环境直接读 localStorage 会话 + `GET /auth/v1/user` |
| 会话订阅 | `auth.onAuthStateChange(...)` | 小程序等无订阅的场景：手动在登录/登出点同步状态 |
| 令牌刷新 | SDK 内置 `autoRefreshToken` | 临期（<30s）调 `POST /auth/v1/token?grant_type=refresh_token` |
| Edge Function 调用 | `client.functions.invoke(name, {body})` | 普通 `POST <url>/functions/v1/<name>` + JSON body |

> **无官方 SDK 的平台**（如某些小程序）：GoTrue 是标准 REST 服务，直接调
> `/auth/v1/signup`、`/auth/v1/token?grant_type=password`、`/auth/v1/logout`，
> 头部带 `apikey: <anon>` + `Authorization: Bearer <anon>`，响应体里的
> `access_token` / `refresh_token` 自行持久化即可。

### 7.2 后端语言等价实现（Edge Function → 内部服务）

- **Node/Deno**：直接复用 `supabase/functions/*/core.ts`（纯 fetch）；npm 包
  `@supabase/supabase-js` 用 `createClient(url, serviceRoleKey)` 即为特权客户端。
- **Python**：`supabase-py` 用 service_role key 建客户端；Admin API 用
  `httpx`/`requests` 直连同上。
- **Go / Java / PHP 等**：一律「HTTP + Admin API + PostgREST」三件套，密钥走环境变量。

### 7.3 移植时按此清单核对（避免漏项）

- [ ] 环境变量：URL / ANON 进前端，SERVICE_ROLE 只进后端
- [ ] 账号 normalize 函数（账号 → 邮箱）与前后端一致
- [ ] 启动恢复会话 + `unknown` 加载态（防闪烁）
- [ ] 登录失败防枚举文案（check-email）——**不要**用 signUp 探测（幽灵账户）
- [ ] 白名单注册校验（check-register）与「查询失败放行」策略
- [ ] 注册后 fire-and-forget 初始化任务
- [ ] 每个业务表 RLS + revoke 权限（自托管必须显式收紧）
- [ ] `mailer_autoconfirm=true` 时注册即登录；否则需处理邮箱确认回调
- [ ] 密码最小长度与 GoTrue 一致（避免 422）

---

## 8. 部署与运维

### 8.1 自托管部署 Edge Functions（本项目实测路径）

```
服务器函数目录: /home/mdc/codes/supabase/volumes/functions/<name>/
  （docker 挂载到容器内 /home/deno/functions，动态加载：放好即生效，无需重启）
```

```bash
# 1. 建目录 + 上传（index.ts + core.ts + core.test.ts）
ssh mdc@10.37.80.25 "mkdir -p /home/mdc/codes/supabase/volumes/functions/check-email"
scp supabase/functions/check-email/* mdc@10.37.80.25:/home/mdc/codes/supabase/volumes/functions/check-email/

# 2. 容器环境变量（必须在函数容器上配置，不是前端）：
#    SUPABASE_SERVICE_ROLE_KEY=<service_role>
#    SUPABASE_URL=http://api-gw:8000   ← 容器内网网关，不是对外 8021

# 3. 通过对外网关验证（本实例对外网关 8021，容器内网 8000，勿混用）
curl -X POST http://10.37.80.25:8021/functions/v1/check-email \
  -H 'Content-Type: application/json' -d '{"email":"someone@example.com"}'
# => {"registered":true|false}
```

### 8.2 云托管（supabase.com）

```bash
supabase link --project-ref <project-ref>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<key> SUPABASE_URL=<https://<ref>.supabase.co>
supabase functions deploy check-email   # 逐个部署 4 个函数
```

数据库迁移两种方式任选：`docker exec -i supabase-db psql ... < migrations/xxx.sql`
（自托管）或 Studio → SQL Editor 整段执行。

### 8.3 密钥管理红线

- ANON：可进前端 bundle；轮换时同时更新 `.env` 与客户端里的默认值。
- SERVICE_ROLE：只在部署端环境变量 / secrets 中，**仓库内不得有任何硬编码值**；
  轮换后所有函数/后端服务的环境变量同步更新。

---

## 9. 安全要点清单

1. **service_role 永不进前端**（自托管内网也不例外）。
2. **探测邮箱存在性用 Admin API，绝不用 signUp**（signUp 会产生幽灵账户）。
3. **白名单表三重防护**：RLS on + 无用户策略 + revoke 表级权限。
4. **RLS 必须逐表核对**：自托管默认给 anon/authenticated ALL 权限。
5. **前端错误提示粒度权衡**：区分「未注册」会泄露注册态——白名单场景可接受，公开注册需评估。
6. **Edge Function 参数校验**：POST 方法限制、必填字段、类型检查（`typeof === 'string'`），
   非法输入返回 400/405。
7. **第三方联动密码即时同步**：平台已有同名账号时，本地生成的随机密码必须经
   管理员接口**同步到平台**再落库（否则用户端永远登录失败）。

---

## 10. 常见坑（踩坑记录）

- **GoTrue `filter` 参数在自托管实例可能不生效**：`GET /auth/v1/admin/users?filter=...`
  返回空 → 改为**拉全量（`per_page=1000`）本地匹配**，大小写不敏感。
- **Admin API 响应是对象不是数组**：`{ users: [...] }`，取 `payload.users`。
- **`signUp` 密码太短返回 422**：前端最小长度必须与 GoTrue 设置一致。
- **URL 拼接用 `new URL('/users', base)` 会替换整个路径**（以 `/` 开头的 path）：
  拼 Admin API 地址务必用字符串拼接 + 单测覆盖。
- **注册后置任务失败不能阻塞注册**：全部 fire-and-forget + 失败仅告警。
- **`unknown` 状态必须渲染加载态**：否则刷新瞬间闪现登录页。
- **账号大小写不一致**导致「已注册但登录不上」：所有 normalize 统一 `toLowerCase()`。
- **只改库不同步平台**：第三方平台（如 new-api）已有同名用户时，新密码需
  `PUT /api/user/` 同步到平台，否则登录永败（见 `newapi-key/core.ts` 的自愈逻辑）。

---

## 附录：本仓库实现文件总览

| 分类 | 文件 | 说明 |
|---|---|---|
| 前端 | `apps/web/src/supabase/supabase-client.ts` | 客户端单例 + 环境变量回退 |
| 前端 | `apps/web/src/supabase/auth-context.tsx` | 状态机 / signUp / signIn / signOut / Edge Function 调用 |
| 前端 | `apps/web/src/supabase/auth-validation.ts` | 纯函数：normalize / 校验 / 错误文案 |
| 前端 | `apps/web/src/supabase/auth-gate.tsx` + `auth-form.tsx` | 门禁 + 表单 |
| 前端 | `apps/web/src/supabase/user-menu.tsx` + `user-avatar.ts` | 用户入口 / 头像 |
| 前端 | `apps/web/src/app/bootstrap.tsx` | `AuthProvider > AuthGate > App` 装配 |
| 前端 | `apps/web/.env.example` | VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 示例 |
| 函数 | `supabase/functions/check-email/` | 登录失败区分未注册/密码错 |
| 函数 | `supabase/functions/check-register/` | 白名单注册资格 |
| 函数 | `supabase/functions/sync-staff-profile/` | 注册后资料同步 |
| 函数 | `supabase/functions/newapi-key/` | 注册后第三方账号联动 |
| 迁移 | `supabase/migrations/user_profiles.sql` | 用户扩展表 + RLS |
| 迁移 | `supabase/migrations/staff_directory.sql` | 白名单表（service_role only） |
| 迁移 | `supabase/migrations/departments.sql` | 部门表 + 开关 |
| 文档 | `docs/oa-account-login.md` | oa账号 ↔ 邮箱映射专项 |
| 文档 | `docs/check-email-registered-login-hint.md` | 防枚举专项（含踩坑） |
| 文档 | `docs/supabase-keys.md` | ANON / SERVICE_ROLE 密钥管理 |