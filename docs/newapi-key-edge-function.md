# Edge Function：newapi-key（为用户分配 new-api apikey）

## 1. 需求

为用户自动分配 new-api 平台的 apikey，流程：

1. 检查 `user_profiles.apikey` 是否为空：
   - 非空 → 直接返回该 apikey（幂等，不重复创建）
   - 空 → 继续
2. 从 `configs` 表读取 `NEWAPI_URL` / `NEWAPI_TOKEN`
3. 在 new-api 平台按 oa账号 查用户是否存在
4. 不存在 → 创建 new-api 用户，并**仅首次创建**时设置账户额度 200
5. 用该用户凭证登录 new-api 创建令牌（归该用户）
6. 取完整令牌 key，写入 `user_profiles.apikey`
7. 返回 apikey

## 2. 部署

- 函数目录：`supabase/functions/newapi-key/`（index.ts + core.ts + core.test.ts）
- 服务器：`/home/mdc/codes/supabase/volumes/functions/newapi-key/`
- 运行时：`supabase-edge-functions` 容器动态加载，放好即生效（无需重启）
- 环境变量（容器内已配置）：`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_URL`（= http://api-gw:8000）

调用：

```bash
curl -X POST http://10.37.80.25:8021/functions/v1/newapi-key \
  -H 'Content-Type: application/json' \
  -d '{"userId":"<supabase user uuid>","oaAccount":"zhangsan"}'
# => {"apikey":"DJfw***..."}
```

## 3. 数据表变更

`supabase/migrations/user_profiles_add_newapi_password.sql`

- `user_profiles` 新增 `newapi_password text`：存储 new-api 平台用户密码
  （Edge Function 创建 new-api 用户时生成随机密码并保存，后续登录/建令牌/续期时复用）

`configs` 表（已存在）：

| key | value |
|-----|-------|
| `NEWAPI_URL` | `http://10.37.80.25:3000`（new-api 平台地址） |
| `NEWAPI_TOKEN` | new-api 管理员 token（root，用于创建用户/设额度） |

## 4. new-api 平台 API（已实测确认）

| 接口 | 方法 | body | 说明 |
|------|------|------|------|
| `/api/user/search?keyword=` | GET | - | 查用户（`data.items[].username/id/quota`） |
| `/api/user/` | POST | `{username, password, display_name}` | 创建用户（管理员） |
| `/api/user/manage` | POST | `{id, action:"add_quota", value:200, mode:"override"}` | 设置用户账户额度 |
| `/api/user/login` | POST | `{username, password}` | 登录，返回 `data.access_token` |
| `/api/token/` | POST | `{name, expired_time:-1, unlimited_quota:false, remain_quota:0}` | 创建令牌（用用户 token，归该用户） |
| `/api/token/?p=1&size=` | GET | - | 列出令牌（用户视角），含 key |

要点（实测结论）：
- 管理员建令牌时 `user_id` 被强制归调用者（root）——因此**用该用户自己的凭证登录后建令牌**，令牌才归该用户
- 创建令牌响应不含完整 key，需从令牌列表取（用户视角列表含 key）
- 用户账户额度通过 `POST /api/user/manage` 设置（`action=add_quota, mode=override, value=200`）

## 5. 核心逻辑（core.ts）

`getOrCreateApiKey(supabaseUrl, serviceRoleKey, userId, oaAccount)`：

```
1. readProfileValue(apikey) → 非空返回
2. readConfigValue(NEWAPI_URL / NEWAPI_TOKEN)
3. findNewApiUser(username=oaAccount)
4. 不存在 → createNewApiUser + setNewApiUserQuota(200)
   密码 = generateRandomPassword(16)，写入 newapi_password
   存在 → 复用存储的密码（缺失则重新生成）
5. loginNewApiUser → createNewApiToken → 取 key
6. writeProfileValue(apikey) → 返回
```

所有 HTTP 通过注入的 `fetch` 完成（测试可 mock）；`generatePassword` 可注入。

## 6. 测试

`supabase/functions/newapi-key/core.test.ts`（node:test，6 用例，mock fetch）：

- apikey 已存在 → 直接返回，不调用 new-api
- 首次创建 → 建用户 → 设额度 200 → 登录 → 建令牌 → 写 apikey
- 用户已存在 → 跳过创建用户与设额度
- configs 缺 NEWAPI_TOKEN → 报错
- `generateRandomPassword` 生成 16 位密码
- `readConfigValue` / `readProfileValue` 基础读取

运行：

```bash
node --test supabase/functions/newapi-key/core.test.ts
```

## 7. 端到端实测记录（真实后端，已通过）

```
创建测试用户 dsh_nk_44121（Supabase + oa_account）
调用 /functions/v1/newapi-key
  → 200 {"apikey":"DJfw***RDGX"}
new-api 平台：用户 dsh_nk_44121 已创建，quota=200（首次创建设额度生效）
user_profiles：apikey 已写入（DJfw***RDGX），newapi_password 已写入（16位随机）
令牌：dsh_nk_44121-1787737044092 归该用户（user_id=3），remain_quota=0（令牌不设额度）
再次调用（幂等）：返回同一 apikey，未重复创建
```

## 8. 安全说明

- `newapi_password` 明文存于 `user_profiles`（自托管内网部署，非公开明文风险）；
  若部署到公网，建议改用加密存储。
- `configs.NEWAPI_TOKEN` 是 new-api 管理员 token（root），仅函数内使用，不暴露给前端。
- 调用方（前端）只持有最终 apikey（令牌 key），该 key 额度受用户账户额度约束。

## 9. 注册后自动获取 apikey

注册成功后，前端 `auth-context.tsx` 的 `signUp` 会**并行**触发两个 Edge Function
（均为 fire-and-forget，失败不阻塞注册）：

1. `sync-staff-profile`：按 staff_directory 填写 user_profiles（部门/区域/岗位/姓名）
2. `newapi-key`：获取/创建 new-api apikey 并写入 `user_profiles.apikey`

```ts
// apps/web/src/supabase/auth-context.tsx
void syncStaffProfile(userId, oaAccount);
void requestNewApiKey(userId, oaAccount);
```

端到端实测（真实数据，已通过）：

```
注册 panyong@yjk.com → 并行调用两个函数
sync-staff-profile → {"synced":true, staff:{department:"方案中心", name:"潘勇", ...}}
newapi-key         → {"apikey":"8Txe***QELR"}

user_profiles：oa_account=panyong, department=方案中心, region=方案设计所,
               position=方案专业总监, apikey=8Txe***QELR
new-api 平台：用户 panyong 已创建，quota=200（首次创建设额度生效）
```
