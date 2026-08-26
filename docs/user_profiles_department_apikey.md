# user_profiles 扩展表：为 auth.users 扩充部门与 API key 字段

## 1. 需求

在 Supabase 中扩充用户表字段，先增加两个字段：
- **department**（部门）
- **apikey**（API key）

## 2. 方案：扩展表（不直接改 auth.users）

不修改 `auth.users`（GoTrue 管理、结构受升级影响），而是新建
`public.user_profiles` 扩展表，一行对应一个用户：

| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | `uuid` PK | 外键 → `auth.users(id)`，`ON DELETE CASCADE` |
| `department` | `text` | 部门 |
| `apikey` | `text` | API key |
| `created_at` | `timestamptz` | 默认 `now()` |
| `updated_at` | `timestamptz` | 默认 `now()`，更新时触发器自动刷新 |

特性：
- **RLS（行级安全）**：4 个策略，用户只能读写自己的行；
- **updated_at 触发器**：`set_updated_at()` 自动更新；
- **自动补行**：为已有用户批量插入 profile 行（`INSERT ... SELECT id FROM auth.users`）。

## 3. 迁移脚本

`supabase/migrations/user_profiles.sql`（本仓库与服务器
`/home/mdc/codes/supabase/migrations/` 均有一份）

执行方式：

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < user_profiles.sql
```

## 4. 执行与验证结果

### 4.1 建表

- `CREATE TABLE`、触发器、4 个 RLS 策略、GRANT 全部成功；
- 为 6 个既有用户自动补行（`INSERT 0 6`）；
- `\d public.user_profiles` 结构完整，`relrowsecurity = t`。

### 4.2 API 层验证（PostgREST）

用 supabase-js 以真实用户 token 实测：

```
READ   → 200，能读到自己的 profile 行
UPDATE → 成功写入 department=研发部, apikey=sk-test-123
READ2  → 读回确认生效（updated_at 被触发器刷新）
OTHERS → 只返回自己的行（RLS 生效，其他用户不可见）
```

## 5. 过程中修复的配置问题：PostgREST 无法验证用户 token

### 现象

用登录用户 token 访问 `/rest/v1/user_profiles` 报：
`No suitable key or wrong key type`；而 service_role key（HS256）访问正常。

### 根因

- GoTrue 用 **ES256**（非对称，`JWT_KEYS` 里的 EC key，kid `f53c4d4e...`）签发用户 token；
- PostgREST 配置 `PGRST_JWT_SECRET: ${JWT_JWKS:-${JWT_SECRET}}`，但 `.env` 里
  `JWT_JWKS` 为空，回退到 HS256 的 `JWT_SECRET` → **无法验证 ES256 用户 token**。

### 修复

1. `.env` 中把 `JWT_JWKS` 设置为 `JWT_KEYS` 的 JSON（`{"keys":[...]}` 包装，含
   EC 公钥 `x`/`y` 与对称 key）；
2. 用 `docker compose up -d --no-deps --force-recreate rest` **重新创建**容器
   （注意：`docker restart` 不会重新应用 compose 环境变量，必须 recreate）。

### 验证

`docker inspect supabase-rest` 显示
`PGRST_JWT_SECRET=[{"kty":"EC",...}`，用户 token 访问恢复 200。

## 6. 经验教训

- **扩展用户信息用独立表 + 外键 + RLS**，不要改 `auth.users`；
- **自托管 Supabase 的 `.env` 修改后必须 `docker compose up -d --force-recreate`**
  才生效，`docker restart` 只重启容器、不重新注入环境变量；
- **PostgREST 验证 JWT 需要与 GoTrue 签发算法一致**：GoTrue 用 ES256 时，
  `PGRST_JWT_SECRET` 必须是包含公钥的 JWKS，不能是 HS256 secret；
- 验证 RLS 用真实用户 token 做"读自己 / 读不到别人"的对照测试。
