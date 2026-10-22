# Change: 云原生存储改造——云端权威、本地仅缓存、凭据上云

## Why

用户确立方向（2026-10-22）：项目改为原生云架构，Supabase 成为全部用户数据的唯一权威，
本地仅作缓存，彻底消除手动同步；API Key 等敏感凭据随数据上云，实现换设备/清浏览器
数据零丢失。现状为 local-first + 周期 reconcile：画板之外的数据面变更不触发自动同步，
编排图/运行记录/提示词墓碑未上云，敏感凭据明确排除在外（`local-collector.ts:34-43`）。

## What Changes

- **BREAKING**：数据权威从本地 IndexedDB/Cache 迁移到 Supabase（user_sync_data /
  user_sync_media / yue-sync 桶）；本地降级为「读缓存 + 离线写队列（outbox）」。
  清空浏览器数据不再丢失数据；登出清缓存成为安全语义。
- 写路径：所有数据面写入点接入统一变更总线（ChangeBus）→ 短防抖事件驱动推送；
  变更先入持久化 outbox，推送成功出队，离线累积、恢复在线按序回放。「手动点同步」
  不再是任何功能的依赖（按钮保留为救急入口）。
- 读路径：启动 stale-while-revalidate——先渲染本地缓存，后台按 lastSync 窗口增量
  校准云端，完成后 diff 刷新 UI；缓存未命中实体按需从云端拉取回填。
- 实时性：订阅 Supabase Realtime（postgres_changes，user_id 过滤）实现多设备秒级
  一致；断线退化为 60s 增量轮询兜底。
- 数据面补齐：新增实体类型 `workflow_graph`（编排图，含 flowgram 编辑器数据）、
  `workflow_run`（编排运行记录，先落盘再上云）；补上 `prompt_deleted` 墓碑采集
  （types.ts:14 已声明从未采集）。
- 凭据上云：新增 `secret` 实体——敏感设置子树 AES-GCM 加密，DEK 由登录密码派生的
  KEK 信封包裹；HTTP 非 secure context 下用纯 JS 实现（@noble/ciphers + @noble/hashes）
  提供真加密兜底，凭据路径禁止现有 aes-gcm.ts 的 Base64 明文降级。
- 前置依赖：`improve-sync-performance`（键全量 + 内容增量化）——事件驱动高频推送的
  成本基础（单次推送成本 O(脏实体数) 而非 O(全量)）。

## Impact

- Affected specs: 新增 `cloud-native-sync`；关联 `improve-sync-performance`（前置）、
  `add-supabase-cloud-sync`（现行实现，未归档）
- Affected code:
  - `packages/drawnix/src/services/supabase-sync/**`（engine / repository /
    local-collector / apply-remote / media-sync + 新增 change-bus / outbox /
    realtime / secrets-keyring）
  - `packages/drawnix/src/contexts/SupabaseSyncContext.tsx`（触发模型改造）
  - `packages/drawnix/src/services/workflow-orchestrator/graph-storage.ts`、
    `workflow-run-service.ts`（写点接线 + 运行记录落盘）
  - 各数据面存储写点：`task-storage-writer.ts`、`prompt-storage-service.ts`、
    `chat-storage-service.ts`、`knowledge-base-service.ts`、`workflow-storage-writer.ts`、
    `utils/settings-manager.ts`
  - `apps/web/src/supabase/auth-context.tsx`（登录密码捕获 → DEK 生命周期）
  - `packages/utils/src/crypto/aes-gcm.ts`（纯 JS 兜底）+ 新依赖
    `@noble/ciphers`、`@noble/hashes`
  - `supabase/migrations/user_sync_data.sql`（仅 entity_type 注释更新；该列无 CHECK
    约束，无 schema migration）
  - `apps/web-e2e/src/**`（换设备恢复 / 断网回放 / 凭据解包 / HTTP 非 localhost 验证）
