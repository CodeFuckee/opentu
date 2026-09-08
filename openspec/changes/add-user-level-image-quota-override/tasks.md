# Tasks

## 1. Implementation
- [x] 1.1 迁移 `generation_usage_user_override.sql`：user_quota_configs 表 + 触发器 + RLS 收口
- [x] 1.2 resolve_image_quota_limit 扩展用户级覆盖（uuid, text 两参），删除旧单参函数
- [x] 1.3 get_image_quota / consume_image_quota 改用两参解析
- [x] 1.4 管理员总览视图 user_quota_overview（仅管理员/service_role 可读）
- [x] 1.5 文档：docs/ai-proxy-edge-function.md（解析链/管理员操作/验收清单）+ CHANGELOG

## 2. Verification
- [ ] 2.1 ai-proxy 后端单测（node --test）通过（边缘函数零改动，回归确认）
- [ ] 2.2 生产实例执行迁移 + 按验收清单第 8 条验证用户级覆盖（合并后由管理员执行，
      需实例 Postgres 凭据）
