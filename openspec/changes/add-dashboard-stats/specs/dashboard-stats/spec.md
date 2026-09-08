# Change: Supabase 后端数据看板（dashboard-stats 边缘函数）

## ADDED Requirements

### Requirement: 看板页面托管在 Supabase 后端

系统 SHALL 提供一个由边缘函数托管的数据看板页面，通过 `GET /functions/v1/dashboard-stats/` 返回自包含 HTML（内联 CSS/JS/SVG 图表，无外部 CDN 依赖）。

#### Scenario: 打开看板页面

- **WHEN** 浏览器访问 `GET /functions/v1/dashboard-stats/`
- **THEN** 返回 200 且 Content-Type 为 text/html 的自包含页面

#### Scenario: 不支持的方法

- **WHEN** 对看板函数发起 POST/PUT/DELETE
- **THEN** 返回 405 Method not allowed

### Requirement: 数据聚合接口

系统 SHALL 提供 `GET /functions/v1/dashboard-stats/overview?days=N` 返回四类聚合统计 JSON：任务统计、用量与额度、用户与组织、文件与存储。

#### Scenario: 任务统计

- **WHEN** 请求 overview 接口
- **THEN** 返回任务总量、按 type/status 分布、成功率（completed/(completed+failed)）、按日趋势与平均耗时

#### Scenario: 用量与额度

- **WHEN** 请求 overview 接口
- **THEN** 返回 `generation_usage` 按周期汇总、最新周期用量、本月用量 Top 用户（含 oa_account 与部门）

#### Scenario: 用户与组织

- **WHEN** 请求 overview 接口
- **THEN** 返回用户总数、按部门/区域分布、最近注册用户、员工花名册数与可用部门数

#### Scenario: 文件与存储

- **WHEN** 请求 overview 接口
- **THEN** 返回 `file_paths`/`response_file_paths` 文件计数，以及 huabu bucket 对象数与总大小（storage 统计失败时降级只返回文件计数）

#### Scenario: 日期范围

- **WHEN** 请求带 `days=N`（默认 30）
- **THEN** 任务统计按该天数的时间范围过滤并按日分组

### Requirement: 数据访问权限

系统 SHALL 使用 service_role 身份（绕过 RLS）聚合数据，且当前不校验调用者身份（暂不做鉴权）。

#### Scenario: 无鉴权访问

- **WHEN** 携带任意 Supabase Bearer token（如 anon key）请求 overview
- **THEN** 返回聚合数据（不校验调用者身份）

#### Scenario: 服务端配置缺失

- **WHEN** 边缘函数缺少 `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPABASE_URL` 环境变量
- **THEN** 返回 500 且错误信息说明配置缺失
