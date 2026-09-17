# Change: 开发监控看板（dev-monitor 边缘函数）

## ADDED Requirements

### Requirement: 看板页面托管在 Supabase 后端

系统 SHALL 提供一个由边缘函数托管的开发监控页面，通过 `GET /functions/v1/dev-monitor/` 返回自包含 HTML（内联 CSS/JS，无外部 CDN 依赖），页面为匿名可取的登录壳。

#### Scenario: 打开开发监控页面

- **WHEN** 浏览器访问 `GET /functions/v1/dev-monitor/`
- **THEN** 返回 200 且 Content-Type 为 text/html 的自包含页面（含登录卡片，不含任何数据）

#### Scenario: 不支持的方法

- **WHEN** 对 dev-monitor 发起 POST/PUT/DELETE
- **THEN** 返回 405 Method not allowed

### Requirement: 状态聚合接口

系统 SHALL 提供 `GET /functions/v1/dev-monitor/status?days=N` 返回 JSON：服务健康探测、任务管线聚合（状态计数/成功率/按模型失败/按天趋势/耗时分位）、最近失败样本、卡死任务列表。

#### Scenario: 健康探测并行且互不阻塞

- **WHEN** 请求 status 接口
- **THEN** 对 PostgREST/GoTrue/Storage/ai-proxy/网关等端点并行探测，单探测 5 秒超时；单个探测失败不影响其余探测结果；网关管理令牌在 configs 缺少 NEWAPI_TOKEN 时返回「未配置」而非失败

#### Scenario: 任务管线口径

- **WHEN** 请求 status 接口
- **THEN** 成功率 = completed / (completed+failed+cancelled)（分母为 0 时为 null）；卡死 = submitted 且 created_at 早于类型阈值（image 10 分钟，video 30 分钟，其余 10 分钟）；cancelled 单列不计入失败

#### Scenario: 平台错误率

- **WHEN** 窗口内存在失败任务
- **THEN** 失败按 error 内容分类为余额不足/上游失败/平台（关键词匹配整 error 对象文本 + httpStatus 502/503/504）；平台错误率 = 平台错误失败 / (completed + cancelled + 平台错误失败)，余额不足与上游失败的任务整体排除在分子分母之外，分母 0 时为 null

#### Scenario: 结果完整性

- **WHEN** 窗口内存在 completed 的 image/video/audio 任务
- **THEN** 按其 response_file_paths 推导 {用户名}/{日期}/ 前缀并经 Storage list API 并行核验（前缀上限 400，超限计「未核验」不计异常）：response_file_paths 为空计「结果未归档」，路径在 bucket 不存在计「不在 bucket」，对象存在但 size=0 计「零字节」；chat 纯文本任务不参与统计

#### Scenario: 失败样本与卡死列表

- **WHEN** 窗口内存在 failed 任务或卡死任务
- **THEN** 失败样本返回最近 50 条（时间、OA 账号、类型、模型、耗时、error 摘要）；卡死列表按等待时长倒序

#### Scenario: 日期范围

- **WHEN** 请求带 `days=N`（默认 7，范围 1~90）
- **THEN** 任务管线聚合按该天数的时间范围过滤并按日分组

### Requirement: 数据访问权限

系统 SHALL 对 `/status` 实施管理员门禁：有效用户 JWT + 数据库统一 RPC is_admin()；未登录/无效 token 401，非管理员 403（fail-closed）。页面 JS 仅携带 anon key 与登录会话 token，service_role 仅在函数内使用。

#### Scenario: 未登录访问数据接口

- **WHEN** 不带 Authorization 请求 `/status`
- **THEN** 返回 401

#### Scenario: 非管理员访问数据接口

- **WHEN** 携带非管理员用户 JWT 请求 `/status`
- **THEN** 返回 403
