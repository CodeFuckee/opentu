# user_profiles.password：记录 Supabase 账号密码（开发者测试用）

## 1. 需求

`user_profiles` 表增加 `password` 字段，记录用户 Supabase 账号的明文密码，
方便开发者测试时直接登录各测试账号（无需问用户要密码或走管理端改密）。

## 2. 方案

### 2.1 迁移

`supabase/migrations/user_profiles_add_password.sql`：

```sql
alter table public.user_profiles
  add column if not exists password text;
```

执行方式（自托管 Supabase，与其它迁移一致）：

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres \
  < supabase/migrations/user_profiles_add_password.sql
```

### 2.2 回写时机（auth-context.tsx）

Supabase（GoTrue）只在 `auth.users.encrypted_password` 存 bcrypt 哈希，服务端
拿不到明文，因此由前端在**密码刚被验证有效**的两个时机回写：

- **注册成功**（`signUp`）：与 `sync-staff-profile` / `newapi-key` 并行
  fire-and-forget upsert `{ user_id, password }`（本实例 `mailer_autoconfirm=true`，
  注册即有会话，RLS 写自己的行放行）；
- **登录成功**（`signIn`）：`signInWithPassword` 成功即证明密码当前有效，
  顺手刷新记录——密码若被管理员改过，用户下次登录后记录自动跟上。

两处均为 fire-and-forget：失败只 `console.warn`，不阻塞注册/登录主流程。

## 3. 安全边界（务必知悉）

- **RLS 不变**：`user_profiles` 原有 4 条策略（只能读写自己的行）覆盖新列；
  普通用户 token 读不到别人的密码，未登录 anon 一行都读不到；
- **读取全部用户密码**需要 service_role key 或数据库直连（docker exec psql），
  与 `newapi_password` 同级（见 `user_profiles_add_newapi_password.sql` 的内网先例）；
- ⚠️ **明文密码属高敏数据**：本字段仅建议内网/测试环境使用；若实例对外开放，
  应清空该列并去掉回写逻辑（删除 `auth-context.tsx` 中 `recordAccountPassword` 的两处调用即可）。

## 4. 验证

- 单测：`apps/web/src/supabase/auth-context.spec.tsx`（注册/登录成功回写、失败不回写、
  回写失败不阻塞，共 5 例）；web 子项目 `test` / `typecheck` / `lint` 全绿；
- 线上验证：注册或登录一次后，
  `docker exec -it supabase-db psql -U supabase_admin -d postgres -c "select user_id, password from user_profiles limit 5"`
  应能看到回写结果。

## 5. 关联文件

- `supabase/migrations/user_profiles_add_password.sql`（迁移）
- `apps/web/src/supabase/auth-context.tsx`（回写逻辑）
- `apps/web/src/supabase/auth-context.spec.tsx`（单测）
- `supabase/migrations/user_profiles.sql`（user_profiles 基础表与 RLS）
