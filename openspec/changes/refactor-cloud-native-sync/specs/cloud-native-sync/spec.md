## ADDED Requirements

### Requirement: 云端权威存储

系统 SHALL 以 Supabase（`user_sync_data` / `user_sync_media` / `yue-sync` 桶）作为全部用户数据的唯一权威存储；本地 IndexedDB / Cache Storage 中的数据 SHALL 仅作为读缓存与离线写队列存在，清空本地存储不得导致数据丢失。

#### Scenario: 新设备首次登录

- **WHEN** 用户在无任何本地缓存的浏览器登录
- **THEN** 画板、文件夹、任务、工作流、编排图、提示词、聊天、知识库、设置与凭据全部从云端拉取并渲染，应用完整可用

#### Scenario: 清空浏览器数据后恢复

- **WHEN** 用户清除站点数据后重新登录
- **THEN** 全部数据从云端完整恢复，敏感凭据凭登录密码解包恢复

### Requirement: 本地缓存与离线写队列

读操作 SHALL 优先命中本地缓存以保证即时响应；写操作 SHALL 先写本地缓存并记入持久化 outbox，再异步推送云端；网络恢复后 outbox SHALL 按序回放，且回放不得用旧数据覆盖云端较新数据。

#### Scenario: 断网编辑后恢复

- **WHEN** 网络中断期间用户编辑画板或保存提示词
- **THEN** 操作即时生效于本地 UI，恢复联网后变更自动按序上传云端，无数据丢失

#### Scenario: 回放防旧覆新

- **WHEN** outbox 中积压的变更回放时云端已存在 updatedAt 更新的同实体数据
- **THEN** 放弃本次回放并以云端数据为准，冲突记录日志

### Requirement: 事件驱动自动同步

任何数据面（画板、文件夹、任务、工作流、编排图、提示词、聊天、知识库、音频、素材、角色、设置）的写入 SHALL 通过统一变更总线触发云端推送（短防抖聚合）；系统 SHALL NOT 依赖用户手动触发同步。

#### Scenario: 保存提示词自动上云

- **WHEN** 用户保存一条提示词
- **THEN** 数秒内自动推送云端，无需任何手动同步操作

#### Scenario: 离线状态可见

- **WHEN** 存在未送达云端的待同步变更
- **THEN** 界面显示待同步状态与数量徽标

### Requirement: 实时变更推送

已登录客户端 SHALL 订阅云端本用户数据变更（Supabase Realtime），将变更应用到本地缓存并刷新 UI；Realtime 不可用或断线时 SHALL 退化为周期增量轮询，保证多设备最终一致。

#### Scenario: 双设备同时在线

- **WHEN** 设备 A 修改画板或编排图
- **THEN** 设备 B 在秒级收到推送并刷新对应视图

#### Scenario: Realtime 不可用降级

- **WHEN** Realtime 连接失败或自托管环境未启用 Realtime
- **THEN** 客户端以周期增量轮询保持最终一致，功能不缺失

### Requirement: 敏感凭据云同步（加密）

API Key 等敏感设置 SHALL 作为独立 `secret` 实体加密上云：内容 SHALL 以 AES-GCM 加密，数据密钥 SHALL 由用户登录密码派生的 KEK 信封包裹；在非 secure context（HTTP）下 SHALL 采用纯 JS 真加密兜底，凭据路径禁止明文降级。

#### Scenario: 换设备登录凭据可用

- **WHEN** 用户在新设备登录
- **THEN** 以登录密码解包数据密钥，全部 API Key 自动恢复，无需重新填写

#### Scenario: 云端数据静态防泄露

- **WHEN** `user_sync_data` 表中该用户的行被导出
- **THEN** 在无用户密码的情况下 secret 实体不可还原出明文凭据

#### Scenario: HTTP 环境可用

- **WHEN** 应用经非 localhost 的 HTTP 地址访问（crypto.subtle 不可用）
- **THEN** 凭据加密/解密仍以纯 JS 真加密路径工作，不降级为明文

### Requirement: 数据面全量覆盖

工作流编排图（含 flowgram 编辑器数据）、编排运行记录、提示词删除墓碑 SHALL 纳入云同步实体；各数据面存储写入点 SHALL 接入统一变更总线。

#### Scenario: 编排图跨设备

- **WHEN** 用户在设备 A 编辑工作流编排图并保存
- **THEN** 设备 B 打开编排器时加载到云端最新图

#### Scenario: 提示词删除跨设备

- **WHEN** 用户在设备 A 删除一条提示词
- **THEN** 设备 B 同步后该提示词同样被删除

#### Scenario: 未知实体类型向后兼容

- **WHEN** 旧版本客户端从云端拉取到其不认识的 entity_type 行
- **THEN** 安全跳过该行，不崩溃、不损坏数据

### Requirement: 冲突处理与升级迁移

多端并发 SHALL 沿用「最后写入赢 + 画板元素级合并」语义；存量用户升级后 SHALL 在登录 reconcile 时自动完成新增实体的首次上推，全程无手动迁移步骤。

#### Scenario: 存量用户无感升级

- **WHEN** 老用户升级到新版本并登录
- **THEN** 其本地编排图、运行记录自动上推云端，既有画板/任务等数据不受影响

#### Scenario: 读路径切换可回退

- **WHEN** 云权威读路径出现异常
- **THEN** 可通过功能开关回退到 local-first reconcile 模式，数据不损坏
