# Change: 同步增量拉取与键扫描

## ADDED Requirements

### Requirement: 远程拉取键全量、内容增量

同步 SHALL 每次以轻列扫描获得全量远程键集合（entity_type/entity_id/updated_at/
deleted_at，供墓碑判定）；实体内容 SHALL 仅在首次同步（无 lastSyncTime）或
`updated_at > lastSyncTime` 窗口内拉取。

#### Scenario: 非首次同步只拉窗口内容

- **WHEN** 上次同步时间存在且云端无该窗口外的变更
- **THEN** 内容拉取仅返回 `updated_at > lastSyncTime` 的行，键扫描仍返回全量键

#### Scenario: 软删除墓碑入窗

- **WHEN** 云端实体在窗口内被软删除（deleted_at 与 updated_at 同步更新）
- **THEN** 该行进入窗口拉取结果，merge 将其分类为 toDeleteLocally

#### Scenario: 首同步保持全量

- **WHEN** lastSyncTime 为 null（换设备/清缓存）
- **THEN** 内容拉取不做窗口过滤，行为与现版本一致

### Requirement: 本地收集键全量、内容按需

本地收集 SHALL 拆为轻量键扫描（全量实体 type/id/updated_at）与按需内容构建
（仅 diff 所需脏实体序列化 content）；本地墓碑判定语义保持不变。

#### Scenario: 本地删除不丢墓碑

- **WHEN** 本地已删除某实体且云端该行未变更
- **THEN** 键扫描缺失该键、远程全量键含该键 → 分类为 toTombstoneRemotely 软删除云端

### Requirement: 同步阶段耗时可观测

runSync 结果 SHALL 携带各阶段耗时（收集/远程拉取/比对/上传/下载/总耗时），同步
完成后输出到控制台日志，用于量化增量优化效果与回归对比。

#### Scenario: 同步完成后输出阶段耗时

- **WHEN** 一次同步完成（成功或失败）
- **THEN** 返回结果包含 stageTimings 且控制台输出
