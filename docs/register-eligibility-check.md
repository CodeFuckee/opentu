# 功能说明：注册资格校验（staff_directory + departments）

## 1. 需求

注册时校验 oa账号：

1. oa账号 **不在** `staff_directory` 表 → 提示：
   「Yue画布只供越建科内部人员使用，如果您是员工，请联系科创中心陈锴迪」
2. oa账号在 `staff_directory`，但其 `department` 对应 `departments` 表
   行数据的 `enabled = false` → 提示：
   「Yue画布目前只提供给方案中心、设计中心、环艺中心部门使用，
   如果您是部门员工，请联系科创中心陈锴迪」
3. 在 staff_directory 且部门 enabled=true → 允许注册

## 2. 数据表

| 表 | 关键字段 | 说明 |
|----|---------|------|
| `staff_directory` | `oa_account`（唯一）、`department`（text）、`name`/`region`/`position` | 员工目录（2015 人），**无 RLS 策略**（anon 不可读） |
| `departments` | `name`（唯一）、`enabled`（bool 默认 true） | 部门启用状态；当前仅「方案中心/设计中心/环艺中心」enabled=true |

关联：`staff_directory.department`（text）匹配 `departments.name`（text）；
实测所有 staff 的 department 均能匹配到 departments 行（0 orphan）。

## 3. 为什么用 Edge Function

`staff_directory` 无 RLS 策略（anon 读不到），前端直接查不到；
因此用 **Edge Function `check-register`**（service_role 通过 PostgREST 查询），
与既有 `check-email` / `newapi-key` 同一模式。

## 4. Edge Function

`supabase/functions/check-register/`（已部署至服务器 `volumes/functions/check-register/`）

请求：`POST /functions/v1/check-register`，body `{ "oaAccount": "zhangsan" }`

响应：
```json
{ "eligible": true }
{ "eligible": false, "reason": "not-staff" }
{ "eligible": false, "reason": "department-disabled" }
```

逻辑（core.ts）：
1. `GET /rest/v1/staff_directory?oa_account=eq.<oa>&select=oa_account,department&limit=1`
   - 无行 → `not-staff`
2. 有行 → `GET /rest/v1/departments?name=eq.<department>&select=name,enabled&limit=1`
   - 无行或 `enabled=false` → `department-disabled`
   - `enabled=true` → `eligible`

## 5. 前端改动

| 文件 | 说明 |
|------|------|
| `apps/web/src/supabase/auth-validation.ts` | `RegisterEligibility` 类型 + `getRegisterDeniedMessage()`（两条提示文案） |
| `apps/web/src/supabase/auth-context.tsx` | `checkRegisterEligibility(oaAccount)` 调 Edge Function |
| `apps/web/src/supabase/auth-form.tsx` | 注册提交前先校验：不通过 → 提示对应文案并中止；查询失败（null）→ 放行不阻塞注册 |

## 6. 测试

- Edge Function：`supabase/functions/check-register/core.test.ts`（5 用例，mock fetch）
  - not-staff / department-disabled / eligible / 部门未登记 / 大小写
- 前端：`auth-validation.spec.ts` 新增 2 用例（两条提示文案）
- 运行：`node --test supabase/functions/check-register/core.test.ts`、
  `nx run web:test`、`nx run web:typecheck`、`nx run web:build-app`

## 7. 端到端实测（真实数据，已通过）

```
POST /functions/v1/check-register {"oaAccount":"panyong"}        => {"eligible":true}          （方案中心 enabled=true）
POST /functions/v1/check-register {"oaAccount":"lingjiabin"}     => {"eligible":false,"reason":"department-disabled"} （工程中心 enabled=false）
POST /functions/v1/check-register {"oaAccount":"not_a_staff_xyz"} => {"eligible":false,"reason":"not-staff"}
```

## 8. 边界与说明

- 查询失败（Edge Function 不可用/网络错误）时前端**放行注册**，避免阻塞用户；
  若需严格拦截，可改为失败即拒绝（届时调整 `auth-form.tsx` 一处逻辑即可）。
- 部门未在 `departments` 登记时按「未开放」处理（department-disabled）。
- 文案中的联系人均为「科创中心陈锴迪」，如需变更只改
  `getRegisterDeniedMessage()` 两处字符串。
