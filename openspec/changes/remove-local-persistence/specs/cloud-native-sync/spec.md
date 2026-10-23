## MODIFIED Requirements

### Requirement: 云端权威存储

系统 SHALL 以自托管 Supabase Postgres（`user_sync_data` / `user_sync_media` 表与 `yue-sync` 桶）作为全部用户数据的唯一持久层；浏览器端 SHALL NOT 在 IndexedDB 中持久化任何用户数据副本。允许保留的非权威本地状态仅限：Cache API 媒体性能缓存、Service Worker 静态资源缓存、localStorage 瞬态键（会话、UI 偏好、关闭前快照、数据密钥缓存）。清空浏览器数据 SHALL NOT 造成任何用户数据丢失。

#### Scenario: 新设备首次登录

- **WHEN** 用户在无任何本地缓存的浏览器登录
- **THEN** 画板、文件夹、任务、工作流、编排图、提示词、聊天、知识库、设置与凭据全部从云端拉取并渲染，应用完整可用

#### Scenario: 清空浏览器数据后恢复

- **WHEN** 用户清除站点数据后重新登录
- **THEN** 全部数据从云端完整恢复，敏感凭据凭登录密码解包恢复

#### Scenario: IndexedDB 审计为零

- **WHEN** 对应用执行 IndexedDB 使用审计
- **THEN** 不存在任何用户数据的 IndexedDB 持久化写入路径（localforage 实例已移除或仅剩瞬态缓存用途）

### Requirement: 冲突处理与升级迁移

并发写语义 SHALL 为整板 last-write-wins 加乐观锁：保存请求 SHALL 携带读取时的 `updated_at` 做条件更新，条件更新 SHALL 以服务端统一时钟生成的 `updated_at` 为基准；条件不命中（0 行更新）SHALL 视为冲突——拒绝覆盖、保留内存态、提示用户刷新。系统 SHALL NOT 实现画板元素级合并。存量本地数据 SHALL 在切换时经一次强制全量上推收口，全程无手动迁移步骤。

#### Scenario: 双窗口并发编辑同一画板

- **WHEN** 窗口 A 与窗口 B 同时打开画板 X，B 先保存成功，A 随后保存
- **THEN** A 的保存因 `updated_at` 条件不命中被拒绝，A 收到「画板已在其他窗口/设备修改，请刷新」提示且内存内容不丢失，云端保持 B 的版本

#### Scenario: 正常串行保存

- **WHEN** 仅一个窗口编辑画板并触发防抖保存
- **THEN** 保存成功，云端 `updated_at` 更新为服务端时间

#### Scenario: 存量用户无感切换

- **WHEN** 老用户升级到云端唯一存储版本并登录
- **THEN** 应用先执行一次本地存量全量上推并核对完成，随后进入云端直连模式，无数据缺失

## REMOVED Requirements

### Requirement: 本地缓存与离线写队列

**Reason**: 本地不再有任何持久化数据副本，读缓存 SWR、持久化 outbox 离线队列与冷启动等待（waitForFirstReconcile）失去存在前提。
**Migration**: 读写直连云端（见「云端直连读写」）；写失败改为内存保留＋未同步提示＋自动重试；断网时编辑不可用（已接受的云端单点，明确提示而非静默排队）。

### Requirement: 事件驱动自动同步

**Reason**: 单副本架构下不存在「同步」——写路径变为防抖直写云端，统一变更总线、推送器与同步互斥锁随之退役。
**Migration**: 直写语义见「云端直连读写」；多设备感知由「实时变更推送」承担（定向重拉）。

## ADDED Requirements

### Requirement: 云端直连读写

应用 SHALL 在启动时经「登录→拉取画板树→按需拉取当前画板内容」后渲染，切换画板 SHALL 按需从云端懒拉；各数据面写入 SHALL 以防抖聚合直写云端；写失败时 SHALL 保留内存态、展示未同步状态并自动重试。系统 SHALL NOT 为读写用户数据而访问 IndexedDB。

#### Scenario: 冷启动直拉渲染

- **WHEN** 已登录用户打开页面
- **THEN** 应用从云端拉取画板树与当前画板内容后渲染画布，加载过程不读取任何本地持久化数据

#### Scenario: 写失败可见可恢复

- **WHEN** 防抖保存时网络不可用
- **THEN** 内容保留在内存并显示「未同步」状态，恢复在线后自动重试成功并清除提示

### Requirement: 远端变更定向刷新

客户端收到云端变更通知（Realtime 或轮询兜底）后，SHALL 定向重新拉取受影响实体；当前画板无未保存修改时 SHALL 自动应用刷新，存在未保存修改时 SHALL 提示用户而不静默覆盖。

#### Scenario: 他端修改当前画板且本端无编辑

- **WHEN** 设备 B 修改画板 X，设备 A 正打开画板 X 且无未保存修改
- **THEN** 设备 A 自动重拉并在画布上呈现 B 的最新内容

#### Scenario: 他端修改当前画板且本端有未保存编辑

- **WHEN** 设备 B 修改画板 X，设备 A 对画板 X 存在未保存修改
- **THEN** 设备 A 提示「画板已在其他窗口/设备修改」，不覆盖用户正在编辑的内容
