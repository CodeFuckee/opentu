# cloud-sync Specification

## Purpose
将全部本地数据同步到 Supabase，实现登录用户跨浏览器/设备的数据一致性。TBD - 归档后更新 Purpose。

## Requirements

### Requirement: 登录用户数据按账号云同步
系统 SHALL 在用户登录 Supabase Auth 后，将该用户的本地数据（画板、文件夹、任务、工作流、提示词、知识库、聊天会话与消息、音频播放列表、AI 角色、素材库元数据、缓存媒体元数据、设置、自定义工具）同步到 Supabase，并支持在任意浏览器/设备登录同一账号后恢复相同数据。

#### Scenario: 首次登录自动上传本地数据
- **WHEN** 用户首次登录且云端无该用户同步记录
- **THEN** 系统自动将本地全量数据上传到云端
- **AND** 云端完成该用户首批 `user_sync_data` 记录写入

#### Scenario: 换设备登录下载数据
- **WHEN** 用户在另一浏览器/设备登录同一账号
- **THEN** 系统下载云端数据并合并到本地
- **AND** 之前设备创建的画板、任务、聊天等记录在本地可见

### Requirement: 增量同步与冲突合并
系统 SHALL 在登录后执行增量同步：按实体 `updated_at` 与内容校验和判断上传/下载，双方都修改的冲突按「较新版本优先」处理，画板冲突执行元素级合并。

#### Scenario: 双端修改同一画板
- **WHEN** 本地与云端同一画板在各自设备上被修改
- **THEN** 系统按元素 ID 合并两个版本
- **AND** 合并结果同时写回本地与云端

#### Scenario: 单端修改增量同步
- **WHEN** 仅本地（或仅云端）的某实体 `updated_at` 更新
- **THEN** 系统仅上传（或下载）该实体
- **AND** 未变更实体不重复传输

### Requirement: 媒体文件云端存储
系统 SHALL 将媒体二进制（素材库图片、AI 生成图片/视频/音频、画布内图片）上传到 Supabase Storage 私有桶，`user_sync_media` 表仅存元数据；下载时按需拉取并写入本地 Cache。

#### Scenario: 素材库图片跨设备可见
- **WHEN** 设备 A 上传了素材库图片到云端
- **THEN** 设备 B 登录后同步时按元数据下载该图片到本地缓存
- **AND** 素材库在设备 B 可见完整图片

### Requirement: 删除通过墓碑软同步
系统 SHALL 以软删除（tombstone）方式同步删除操作：实体本地删除后云端标记 `deleted_at`，其他设备同步时据此删除本地副本，且删除受安全保护（首次同步不删除、当前画板保护、批量删除需警告）。

#### Scenario: 一设备删除画板后其他设备同步删除
- **WHEN** 设备 A 删除某画板并同步
- **THEN** 云端该画板记录 `deleted_at` 被标记
- **AND** 设备 B 同步后该画板从本地移除

### Requirement: 手动与自动同步触发
系统 SHALL 提供手动同步（立即、上传、下载）并支持变更后自动防抖同步；同步失败不阻塞本地使用并以状态指示器提示。

#### Scenario: 手动同步按钮
- **WHEN** 用户点击「立即同步」
- **THEN** 系统执行一次完整增量同步并更新同步状态

#### Scenario: 自动同步
- **WHEN** 本地数据变更且距离上次同步超过防抖窗口
- **THEN** 系统自动触发一次增量同步

### Requirement: 数据访问隔离
系统 SHALL 通过 RLS 保证用户只能读取/写入自己的同步数据；匿名（anon）角色无权访问同步表与媒体桶。

#### Scenario: 用户间数据隔离
- **WHEN** 用户 A 与用户 B 分别登录
- **THEN** 用户 A 无法通过任何查询读取用户 B 的 `user_sync_data` / `user_sync_media` 记录
- **AND** 匿名请求被 RLS 拒绝

### Requirement: 移除 GitHub Gist 同步
系统 SHALL 移除 GitHub Gist 同步模块及 Gist 相关 UI 入口，同步设置改为展示 Supabase 登录账号与同步状态。

#### Scenario: 同步设置面板
- **WHEN** 用户打开同步设置
- **THEN** 面板展示当前登录账号、同步状态、最近同步时间与手动同步操作
- **AND** 不再出现 GitHub Token / Gist 配置项