# Change: 同步性能专项——键全量+内容增量化、阶段计时、E2E 数据治理

## Why

云端同步为全量比对式：每次同步全量拉取该用户全部实体（select *，测试账号曾达
5226 行/2.2MB）、全量收集本地快照。数据增长后同步耗时线性上涨（E2E 实测突破
用例 30s 等待窗，cloud-sync 簇 5 用例失败；真实用户数据增长后同样受影响）。
比对逻辑（merge）与 checksum（32 位 FNV）本就是增量友好的，瓶颈纯在 I/O 层——
**键全量、内容增量**即可根治。

## What Changes

### 1. 阶段计时与可观测（先落，验证后续优化）

- `runSync` 结果新增 `stageTimings`（collectMs / remoteFetchMs / diffMs /
  uploadMs / downloadMs / totalMs），SupabaseSyncContext 同步完成后输出
  `console.info('[SupabaseSync] stage timings', ...)`，用于量化与回归对比

### 2. 远程拉取增量化（键全量 + 内容增量）

- `fetchRemoteEntities` 拆两级：
  - **键扫描**（每次同步必做）：`select entity_type,entity_id,updated_at,deleted_at`
    （轻列，分页）→ 全量远程键集合，供墓碑判定（knownRemoteKeys 语义保持
    「全量远程键」不变，正确性不降级）
  - **窗口内容拉取**（lastSync 非 null 时）：`updated_at > lastSync` 过滤 +
    `select *`（软删除 bump updated_at，墓碑行天然入窗）；首同步（lastSync
    为 null）保持全量
- 引擎 `knownRemoteKeys` 改由键扫描提供；merge 契约不变

### 3. 本地收集增量化（键全量 + 内容增量）

- `local-collector` 拆两级：
  - **键扫描**：全量实体的 (type,id,updated_at)（IndexedDB 游标轻扫）
  - **内容构建**：仅对 diff 需要的脏实体（updatedAt > lastSync 或引擎回查键）
    构建 content（画板 JSON 序列化是重成本所在，按需执行）
- 墓碑边界保持：本地删除的实体在键扫描中缺失 → 与全量远程键比对 →
  knownRemoteKeys 含它 → toTombstoneRemotely（与现行为一致，不丢墓碑）

### 4. E2E 测试账号数据治理（CI 数据自治）

- test:e2e job（运行于 supabase 主机）新增前置步骤：套件启动前
  `docker exec supabase-db psql` 清理 `e2e_sync_%` 账号的 user_sync_data——
  每轮从干净状态开始，杜绝「失败 retry 添数据 → 同步更慢 → 更失败」的雪球

### 5. 验收口径

- 膨胀账号（≈5000 行）增量同步耗时 < 3s（键扫描+窗口拉取）；首同步不变
- cloud-sync 簇 E2E 转绿；阶段计时日志可在看板/控制台观测
- 既有单测全量适配保持绿；新增键扫描/增量拉取单测

## Impact

- Affected specs: 新增 `supabase-sync-performance` capability
- Affected code:
  - `services/supabase-sync/sync-engine.ts`（knownRemoteKeys 来源 + stageTimings）
  - `services/supabase-sync/repository.ts`（键扫描 + 窗口拉取）
  - `services/supabase-sync/local-collector.ts`（键/内容两级收集）
  - `contexts/SupabaseSyncContext.tsx`（lastSync 传递与计时输出）
  - `.gitlab/ci/quality-test.yml`（e2e 前置数据清理）
  - 各单测适配
- 不动：merge 比对语义、媒体同步（fire-and-forget，增量化另立任务）、后端表结构
- 风险与回退：增量窗口逻辑有单测守护（墓碑/首同步/窗口边界三场景）；若异常，
  lastSync 置 null 即回退全量路径
