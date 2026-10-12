# Change: 数据看板自定义时间范围 + 统计数据导出 Excel

## ADDED Requirements

### Requirement: 自定义时间范围查询

看板系统 SHALL 支持按任意精确日期区间（东八区，YYYY-MM-DD）查询 overview 统计：
页面提供「自定义区间…」选项与起止日期输入；`GET /functions/v1/dashboard-stats/overview`
接受 `start` 与 `end` 参数并按 `start` 当日 00:00:00 至 `end` 当日 23:59:59（东八区）
过滤，区间合法时优先于 `days` 窗口。

#### Scenario: 页面选择自定义区间

- **WHEN** 管理员在看板选择「自定义区间…」、填入起止日期并点击「应用」
- **THEN** 页面以 `overview?start=&end=&days=区间天数` 加载，标题栏显示该区间标签

#### Scenario: 区间参数生效

- **WHEN** 请求 `overview?start=2026-08-07&end=2026-09-30&days=55`
- **THEN** 任务/用量统计按 2026-08-07 00:00:00 ~ 2026-09-30 23:59:59（东八区）过滤

#### Scenario: 区间参数非法

- **WHEN** start/end 格式非 YYYY-MM-DD、非真实日历日期（如 2026-02-30）、只给其一、或 start 晚于 end
- **THEN** 返回 400 与中文错误说明，不回退 days 窗口

#### Scenario: 起止相同

- **WHEN** start 与 end 为同一天
- **THEN** 按单日区间查询成功

### Requirement: 统计数据导出 Excel

系统 SHALL 提供 `GET /functions/v1/dashboard-stats/export`，以与 overview 一致的
`days` / `start`+`end` 参数返回当前区间统计的 .xlsx 附件（Content-Disposition
attachment），仅管理员可访问；工作簿 SHALL 零依赖生成（不引入外部脚本或包）并包含
概览、核心指标、操作类型分布、模型使用分布、每日趋势、24小时分布、部门使用排行、
用户使用排行、部门使用汇总、月度用量趋势、部门分布 sheet，含按钮统计摘要时另附
「按钮统计」sheet（固定近 7/30 天口径）。

#### Scenario: 导出指定区间

- **WHEN** 管理员请求 `export?start=2026-08-07&end=2026-09-30`
- **THEN** 返回 200 与 .xlsx 内容，可被 Excel 打开，各 sheet 数值与同参数 overview 一致

#### Scenario: 页面一键导出

- **WHEN** 管理员在看板点击「导出Excel」
- **THEN** 以当前查询区间请求 /export 并以含统计周期的文件名下载；未登录/过期时先刷新会话重试

#### Scenario: 非管理员或未登录

- **WHEN** 未携带有效用户 JWT 或调用者非管理员
- **THEN** 分别返回 401 / 403，不产生 xlsx 内容

#### Scenario: 区间参数非法

- **WHEN** export 的 start/end 不满足 overview 的区间校验规则
- **THEN** 返回 400 与中文错误说明
