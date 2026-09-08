# Change: 生图月度额度支持用户级覆盖

## Why
当前生图月度限额只支持 部门覆盖 → 全局默认 → 缺省 200 的解析链，无法为个别用户
单独调高/调低额度；部分用户需要更多次数，管理员需要能在 Supabase 里直接按用户修改。

## What Changes
- 新增迁移 `supabase/migrations/generation_usage_user_override.sql`：
  - 新表 `user_quota_configs`（user_id 主键 + quota_limit，check > 0，仅管理员经
    Dashboard 编辑、service_role 访问，不授予 anon/authenticated）；
  - `resolve_image_quota_limit` 签名扩展为 (uuid, text)，解析链变为
    **用户覆盖 → 部门覆盖 → 全局默认 → 缺省 200**，并删除旧单参函数；
  - `get_image_quota` / `consume_image_quota` 改用两参解析；
  - 管理员总览视图 `user_quota_overview`（email/oa_account/部门/覆盖值/当月用量/
    生效限额/剩余），仅管理员与 service_role 可读。
- 管理员操作方式：Supabase Dashboard → Table Editor → `user_quota_configs`
  增/删/改行，每次生图实时解析、改完即生效，删除行即回退默认。
- 文档：`docs/ai-proxy-edge-function.md` 更新解析链、管理员操作说明与验收清单。

## Impact
- Affected specs: image-generation-quota
- Affected code: supabase/migrations/generation_usage_user_override.sql（新增）、
  docs/ai-proxy-edge-function.md；前端与 ai-proxy 边缘函数零改动
  （限额由服务端 RPC 返回，客户端仅展示）。
- 部署：需在实例上执行新迁移；若之后重跑 generation_usage.sql 会回退本改动，
  需再执行本迁移（迁移头注释已说明）。
