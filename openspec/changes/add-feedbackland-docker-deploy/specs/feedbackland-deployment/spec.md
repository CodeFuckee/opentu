## ADDED Requirements
### Requirement: Feedbackland 自托管部署
系统 SHALL 支持将 Feedbackland 反馈平台以 Docker 方式自托管部署，认证使用自托管
Supabase Auth，并在发布流水线的 deploy 阶段与主应用一并构建部署。

#### Scenario: 发布时一并部署 Feedbackland
- **WHEN** 用户手动触发发布流水线（web/api source）且 deploy job 执行
- **THEN** deploy job 依次构建并启动 opentu（yue-huabu @ 8088）与 feedbackland 容器
  （@ 8090）
- **AND** Feedbackland 运行所需环境变量来自 GitLab CI 变量（FL_* 前缀）

#### Scenario: 认证走自托管 Supabase Auth
- **WHEN** 用户访问 Feedbackland 并在注册/登录页提交邮箱与密码
- **THEN** 身份校验由现有自建 Supabase 实例（10.37.80.25:8021）的 Auth 完成
- **AND** 服务端 tRPC / chat / claim 等接口通过 service_role 校验 Supabase access token

#### Scenario: 数据隔离
- **GIVEN** Feedbackland 与 opentu 共享同一自建 Supabase 实例
- **WHEN** 执行部署前数据准备
- **THEN** Feedbackland 应用表位于独立 `feedbackland` 数据库（或降级为独立 schema），
  不与 opentu 表混放
- **AND** storage 的 `images` 桶以增量方式创建

#### Scenario: 侧边栏按钮直达自托管实例
- **WHEN** 用户点击应用侧边栏的 Feedbackland 按钮
- **THEN** 新标签页打开 `FEEDBACKLAND_URL`（指向自托管实例 http://10.37.80.25:8090）
