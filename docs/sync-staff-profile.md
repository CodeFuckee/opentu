# 功能说明：注册成功后按 staff_directory 填写 user_profiles

## 1. 需求

用户注册成功后，根据 `staff_directory` 表里的字段填写 `user_profiles`。

## 2. 字段映射

| staff_directory | user_profiles | 说明 |
|-----------------|---------------|------|
| `department` | `department` | 部门 |
| `region` | `region` | 区域 |
| `position` | `position` | 岗位 |
| `oa_account` | `oa_account` | oa账号 |
| `name`（如 潘勇） | → `auth.users.user_metadata.full_name` | 供前端 UserMenu 头像显示中文名 |

`user_profiles` 无 `name` 字段，因此员工姓名写入 Supabase 用户的
`user_metadata.full_name`（`user-avatar.ts` 已支持从 `full_name` 取头像首字）。

## 3. 实现

### Edge Function `sync-staff-profile`

`supabase/functions/sync-staff-profile/`（已部署至服务器 `volumes/functions/sync-staff-profile/`）

请求：`POST /functions/v1/sync-staff-profile`，body `{ "userId": "<uuid>", "oaAccount": "zhangsan" }`

流程（service_role 操作，staff_directory 无 RLS 策略需特权查询）：
1. `GET /rest/v1/staff_directory?oa_account=eq.<oa>&select=department,region,position,name,oa_account&limit=1`
2. 无行 → `{ "synced": false }`
3. 有行 → upsert `user_profiles`（`on_conflict=user_id` + `Prefer: resolution=merge-duplicates`，
   写入 department/region/position/oa_account）
4. `PUT /auth/v1/admin/users/{id}` 更新 `user_metadata`（full_name/department/region/position/oa_account）
5. 返回 `{ "synced": true, "staff": {...} }`

### 前端

`apps/web/src/supabase/auth-context.tsx`：
- 原 `persistOaAccount`（仅写 oa_account）替换为 `syncStaffProfile(userId, account)`
  （调用 Edge Function，fire-and-forget，失败仅警告不阻塞注册）
- `signUp` 成功后调用

## 4. 测试

- Edge Function：`supabase/functions/sync-staff-profile/core.test.ts`（3 用例）
  - 命中 → upsert user_profiles + 更新 user_metadata（断言 body 字段）
  - 无此 oa账号 → `synced:false` 且无写操作
  - 查询失败 → 抛错
- 前端：`nx run web:typecheck` / `nx run web:test` / `nx run web:build-app` 全绿

## 5. 端到端实测（真实数据，已通过）

```
注册 panyong@yjk.com 用户 dc8b634c-...
POST /functions/v1/sync-staff-profile {"userId":"...","oaAccount":"panyong"}
  → {"synced":true,"staff":{"department":"方案中心","region":"方案设计所","position":"方案专业总监","name":"潘勇","oa_account":"panyong"}}

user_profiles:  department=方案中心, region=方案设计所, position=方案专业总监, oa_account=panyong
auth.users.user_metadata: full_name=潘勇, department=方案中心, region=方案设计所, position=方案专业总监
```

## 6. 说明

- 该函数与 `check-register`（注册资格校验）职责分离：校验用 `check-register`，
  注册成功后的数据同步用 `sync-staff-profile`。
- 若 `staff_directory` 无此 oa账号（理论上注册校验已拦截），函数返回 `synced:false` 不报错。
