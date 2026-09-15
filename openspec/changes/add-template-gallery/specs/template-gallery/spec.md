## ADDED Requirements

### Requirement: 模板广场浏览

系统 SHALL 提供模板中心界面，按分类 tab（含「全部」）展示模板卡片瀑布流，
支持按使用热度与最新抓取排序、按标题关键词搜索；模板卡片 SHALL 展示封面图、
标题、作者、点赞数与提示词摘要。

#### Scenario: 打开模板中心

- **WHEN** 已登录用户从 AI 创作面板打开模板入口
- **THEN** 展示「全部」分类下的模板瀑布流（默认热度排序）

#### Scenario: 分类与排序切换

- **WHEN** 用户切换到某分类或切换 热度/最新 排序
- **THEN** 列表按所选条件重新查询展示

### Requirement: 模板详情与复用

系统 SHALL 提供模板详情视图，展示完整提示词并支持一键复制、
「去创作」填充 AI 创作输入框；工作流类模板 SHALL 支持「导入工作流」；
每次实际使用 SHALL 通过 `use_template` RPC 原子记录使用并累加使用计数。

#### Scenario: 去创作

- **WHEN** 用户在模板详情点击「去创作」
- **THEN** 提示词填入 AI 创作输入框、调用 `use_template`、关闭模板面板

#### Scenario: 导入工作流

- **WHEN** 用户在工作流类模板详情点击「导入工作流」
- **THEN** 工作流步骤经现有 `workflow-converter` 链路导入画布并计数

### Requirement: 模板爬虫同步

系统 SHALL 提供边缘函数 `template-crawler` 从建筑学长站点 JSON 接口同步模板：
列表与详情两阶段、页间控速（≥2s）、按 `source+source_id` 幂等 upsert、
封面图转存 `huabu` bucket 并保留 `source_url` 署名；同步 SHALL 增量执行
（仅拉取新增或内容哈希变更的条目）；触发端点 SHALL 仅限管理员
（JWT 自证 + `dashboard_admins` 白名单）。

#### Scenario: 管理员触发增量同步

- **WHEN** 管理员调用 `POST /crawl`
- **THEN** 函数按控速抓取列表、仅对新增/变更条目拉详情并 upsert 入库，
  返回本次新增/更新/跳过计数

#### Scenario: 非管理员调用被拒

- **WHEN** 非白名单用户调用 `POST /crawl`
- **THEN** 返回 403，不产生任何上游请求

#### Scenario: 源站不可达

- **WHEN** 上游接口连续失败或超时
- **THEN** 函数返回明确错误并保留既有模板数据不变（存量可正常展示）

### Requirement: 模板下线开关

系统 SHALL 支持按来源软下线模板（`status='hidden'`），下线后模板中心
不再展示（RLS 仅放行 active），且不需要删除数据。

#### Scenario: 一键下线来源模板

- **WHEN** 管理员将某来源模板置为 hidden
- **THEN** 模板中心列表与搜索不再返回这些模板
