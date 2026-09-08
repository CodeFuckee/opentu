## MODIFIED Requirements
### Requirement: 月度限额为硬约束
系统 SHALL 在每个自然月内对每用户图像生成张数执行上限，达到上限后的新图像提交 MUST 被拒绝且不产生上游调用。限额按以下顺序解析（取第一个命中值）：用户级覆盖（`user_quota_configs`）→ 部门覆盖（`department_configs` 的 `image_monthly_quota_{部门}`）→ 全局配置（`image_monthly_quota_default`）→ 缺省 200。

#### Scenario: 额度耗尽
- **GIVEN** 用户当月用量已达限额
- **WHEN** 用户再提交生图任务
- **THEN** 系统返回明确的超额错误（含剩余额度信息）
- **AND** 前端展示"本月额度已用完"类提示

#### Scenario: 自然月自动重置
- **GIVEN** 上个月用量等于限额
- **WHEN** 下一个自然月首次提交生图
- **THEN** 扣减基于新月度周期计算，无需人工干预

## ADDED Requirements
### Requirement: 用户级额度覆盖
系统 SHALL 支持管理员按用户覆盖生图月度限额：`user_quota_configs` 表中存在该用户
行（quota_limit > 0）时，其限额 MUST 优先于部门/全局配置；删除该用户行后 MUST
回退到部门/全局解析结果。覆盖仅允许管理员（Dashboard 表属主）或 service_role 配置，
MUST NOT 授予 anon/authenticated 读写。

#### Scenario: 管理员调高单个用户限额
- **GIVEN** 用户张三当前限额为 200（缺省）
- **WHEN** 管理员在 `user_quota_configs` 中为其插入 quota_limit = 1000 的行
- **THEN** 该用户下一次查询额度/生图时限额即为 1000（实时生效，无需重启）

#### Scenario: 删除覆盖回退默认
- **GIVEN** 用户张三存在 quota_limit = 1000 的覆盖行
- **WHEN** 管理员删除该行
- **THEN** 该用户限额立即回退到部门/全局解析结果

#### Scenario: 普通用户不可读取他人配额配置
- **WHEN** anon/authenticated 角色尝试读写 `user_quota_configs` 或查询
  `user_quota_overview` 视图
- **THEN** 操作被拒绝（未授予任何客户端角色权限）
