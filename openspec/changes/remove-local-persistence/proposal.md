# Change: 移除本地持久化——云端 Postgres 唯一存储，整板 LWW＋乐观锁

## Why

用户拍板（2026-10-23）：在 `refactor-cloud-native-sync`（云端权威＋本地缓存 SWR）基础上再进一步——浏览器本地不再保留任何持久化数据副本，IndexedDB 全面退役，所有用户数据的唯一持久层为自托管 Supabase Postgres（媒体二进制仍在 yue-sync 桶）。动机：单副本之后，reconcile／diff／冲突合并／outbox／lastSync 基线／软删除墓碑整套双向同步机制失去存在必要，可整体删除，架构与心智模型大幅简化。云端单点的代价用户已明确接受。

依据知识库：`25-projects/opentu/opentu-cloud-native-sync-direction.md`（2026-10-22 用户确立「云端权威、宁可承担云端单点、换设备/清缓存零丢失」）；`25-projects/opentu/canvas-open-page-data-source-chain.md`（2026-10-23 现行「本地优先 SWR」链路事实，即本变更要移除的对象）。

需要明示的边界：去掉本地副本消除的是「合并代码」，不是并发本身——两个标签页/设备同时编辑同一画板仍是后写者胜。按用户选择（2026-10-23），并发语义采用**整板 LWW＋乐观锁（CAS）**防静默覆盖；元素级行存储与 CRDT 为后续演进路径，本期不做。

## What Changes

- **BREAKING**：数据持久层收敛为云端唯一——IndexedDB（localforage 各实例与 `aitu-app` 库）不再承担任何数据权威或缓存职责，读写在会话内存与云端之间直连完成。清浏览器数据、换设备不再产生本地/云端两份副本。
- **BREAKING**：双向同步机制整体退役——sync-engine（diff/上传/下载）、reconcile（lastSync 增量窗口、防抖基线、visibility 触发）、merge（`mergeBoardElements` 元素级合并、`resolveBoardConflict`）、outbox（离线写队列）、delete-local（墓碑下载侧）及配套测试删除；软删除墓碑改为真删除（云端唯一副本，DELETE 即删，无复活问题）。
- 写路径：各数据面存储服务改为防抖直写云端（LWW）；写失败保留内存态并显示「未同步」状态，恢复在线自动重试；不做跨会话离线队列——断网时编辑不可用，明确提示而非静默排队。`beforeunload` 尽力 flush；localStorage 关闭快照保留为崩溃安全网（瞬态，非数据副本）。
- 读路径：启动＝登录→拉画板树→拉当前画板内容→渲染；切换画板按需懒拉。删除 SWR、`waitForFirstReconcile` 冷启动等待与「云端为空才种默认板」特判（app.tsx `initialize()` 重写）。会话内内存 Map 作读缓存。
- 并发控制：保存携带读取时的 `updated_at` 做条件更新（PostgREST `.eq('updated_at', base)`，0 行命中即冲突）——拒绝覆盖、提示「画板已在其他窗口/设备修改，请刷新」、保留内存态。`updated_at` 由 Postgres 触发器统一生成（CAS 时钟正确性依赖，新增 migration）。
- 多设备感知：保留 Realtime（postgres_changes）订阅——收到非本端变更后定向重拉该实体；当前画板未脏自动刷新，脏则提示。Realtime 不可用退化为 60s 轮询（沿用 infra.ts 现状）。
- 与 `refactor-cloud-native-sync` 的关系：复用其已落地基础设施（repository、Realtime 订阅、媒体同步、数据面盘点结论）；其「本地缓存＋离线写队列（outbox/SWR）」路线由本变更**取代**，对应未完成任务（tasks.md 中相关项）作废或按本变更改写；Phase E secret 信封加密不受影响，仍按原提案推进。归档顺序：先 `refactor-cloud-native-sync`，后本变更。
- 范围澄清：Cache API（`drawnix-images` 等媒体缓存）与 Service Worker 静态缓存是性能缓存，非数据副本，保留；kv-storage/localStorage 中的数据性键在实施期盘点迁云，瞬态键（UI 偏好、会话、关闭快照、DEK 缓存）保留。

## Impact

- Affected specs: `cloud-native-sync`（本变更给出取代性 delta；`refactor-cloud-native-sync` 的「实时变更推送」「数据面全量覆盖」「敏感凭据云同步（加密）」三条 requirement 保持有效）
- Affected code:
  - 删除：`packages/drawnix/src/services/supabase-sync/` 下 `sync-engine`、`reconcile`、`merge`、`outbox`、`local-collector`、`delete-local` 及测试；`checksum` 仅保留键工具（entityKey/parseEntityKey/yieldToMain），diff 校验和部分删除；`sync-mutex` 随单写者模型简化
  - 改造为云端直连：`workspace-storage-service`、`workspace-service`、`app-database`（tasks/workflows/config 三 store）、`knowledge-base-service`（6 store）、`chat-storage-service`（2 store）、`prompt-storage-service`、`character-storage-service`、`audio-playlist-service`、`asset-storage-service`（元数据）、`color-history-service`（数据性则迁云）、`toolbox-service`、`settings-manager`、`kv-storage-service`（数据性键）
  - 保留/微调：`repository.ts`（增加条件更新 CAS 与真删除 DELETE）、`infra.ts`（Realtime＋轮询兜底）、`media-sync`、`apply-remote` 精简为「云端→内存」加载器
  - 重写：`apps/web/src/app/app.tsx` `initialize()` 冷启动链路
  - DB：`supabase/migrations/` 新增 `updated_at` 触发器（统一服务端时钟）；`entity_type` 列无 CHECK 约束，新实体类型无需结构迁移
  - 文档与验证：`apps/web/public/user-manual/`、`CHANGELOG.md`；E2E 覆盖双标签 CAS 冲突、断网提示、冷启动直拉、HTTP 非 localhost 访问（`apps/web-e2e`）
