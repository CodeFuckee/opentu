# 设计：云原生同步（云端权威 + 本地缓存 + 凭据上云）

## Context

现状（代码核实，2026-10-22）：

- **local-first**：本地 IndexedDB/Cache 为权威，Supabase 为多设备载体。实体级增量
  reconcile（引擎 `services/supabase-sync/sync-engine.ts`；仓库层 `repository.ts`
  upsert onConflict `(user_id,entity_type,entity_id)` + lastSync 窗口拉取；合并
  `merge.ts` LWW + 画板元素级合并；软删除墓碑）。
- **触发面窄**：`contexts/SupabaseSyncContext.tsx:287-343` —— 登录即同步、仅
  board/folder 六事件 30s 防抖、切后台补同步。任务/提示词/聊天/KB/工作流/设置的
  变更不触发同步，只能等下次画布变更/切后台顺带带走——这是「感觉要手动点同步」的根源。
- **未上云**：编排图（`workflow-orchestrator/graph-storage.ts` KV `workflow_graph:*`，
  同步采集器不读）、编排运行态（`workflow-run-service.ts:8-9` 纯内存）、提示词删除
  墓碑（`types.ts:14` 声明未采集）、敏感凭据（`local-collector.ts:34-43` SENSITIVE_KEYS
  递归脱敏剔除）。
- **媒体**：SHA-256 内容寻址上 `yue-sync` 桶 + 本地 Cache 回写（`media-sync.ts`），
  已具「云权威 + 本地缓存」雏形，是其余数据面的参照模板。
- **加密现状**：`packages/utils/src/crypto/aes-gcm.ts`（PBKDF2-SHA256 100k + AES-GCM）；
  HTTP 非 secure context 下 `crypto.subtle` 不可用 → encrypt 降级 Base64 明文
  （`OPENTU_FB:` 前缀）。本地设置敏感字段加密密钥为 device-ID（`utils/crypto-utils.ts:21-40`，
  混淆级，不出设备）。settings 上云前后双端脱敏（collector SENSITIVE_KEYS /
  `apply-remote.ts:298-315`）。
- **部署硬约束**（仓库 AGENTS.md）：HTTP 明文内网部署，非 localhost 访问为主形态，
  secure-context 专属 API 必须有降级路径并实测；部署仅由用户手动触发。
- **认证**：邮箱+密码（`apps/web/src/supabase/auth-context.tsx:218-228`），会话由
  supabase-js 持久化 localStorage，AuthGate 强制登录——登录时序中密码天然在手。
- **表约束**：`entity_type` 为 text 无 CHECK 约束（`supabase/migrations/user_sync_data.sql:18`），
  新增实体类型无需 schema migration。
- **相关变更**：`openspec/changes/improve-sync-performance`（键全量 + 内容增量化，
  本方案高频推送的成本前提）；`openspec/changes/add-supabase-cloud-sync`（现行实现
  设计文档，未归档）。

依据知识库：`25-projects/opentu/README.md`（架构与模块要点）、
`25-projects/opentu/opentu-generated-media-delivery-archive.md`（生图交付与归档两条线分工）。

## Goals / Non-Goals

- Goals:
  - Supabase 成为全部用户数据唯一权威；本地 = 读缓存 + 离线写队列；换设备/清缓存零丢失
  - 消灭手动同步：任何数据面写入秒级自动上推；多设备 Realtime 秒级一致
  - API Key 等凭据加密上云，换设备登录自动恢复
  - 存量用户无感迁移；新旧客户端混跑不损坏数据
  - HTTP 非 secure context 全路径可用（含凭据加密）
- Non-Goals:
  - 不更换后端、不引入新存储（继续自托管 Supabase）
  - 不做多人实时协作编辑（光标级协同）——仍是单人多设备数据同步
  - 不做端到端机密计算：凭据加密目标是**静态防泄露**（DB 导出不可还原明文）；HTTP
    明文传输决定了服务端与链路仍在信任边界内，如实声明不夸大
  - 不重写业务存储接口（IndexedDB 读写 API 保持，语义降级为缓存）

## 架构总览（目标态）

```text
写: UI → 业务服务 → 本地缓存(立即生效) → ChangeBus 事件 → Outbox(持久化)
       → SyncPusher(2s 防抖/在线即推) → Supabase(user_sync_data / yue-sync)
读: UI → 本地缓存命中即返回；未命中/失效 → 云端拉取回填
推: Realtime(postgres_changes, user_id=eq.{uid}) → 缓存失效刷新
       断线 → 60s lastSync 增量轮询兜底
启动: 登录 → SWR(先渲染缓存 ‖ 后台窗口 reconcile) → diff 刷新 UI
凭据: settings 敏感子树 → AES-GCM(DEK) → secret 实体(DEK 由密码派生 KEK 包裹)
```

## Decisions

### D1 权威存储与数据面：沿用现表，新增三种实体类型

- 决策：不建新表。`user_sync_data.entity_type` 新增 `workflow_graph`（content=编排图
  JSON）、`workflow_run`（content=运行记录快照，带数量/时间保留策略）、`secret`
  （content=信封加密凭据包）；`prompt_deleted` 补采集。仅更新 migration 注释。
- 备选：每类数据独立表——更「规范」但迁移/RLS/仓库层成本高，通用表已验证可行，不取。

### D2 读路径：stale-while-revalidate

- 决策：读永远走本地缓存（业务 API 不变）；登录/启动时后台 reconcile（lastSync 增量
  窗口，复用 `fetchRemoteEntities`），完成后按 diff 刷新 UI；缓存未命中实体按需拉取
  回填。冷启动（无缓存）显示加载进度；拉取分页（BATCH_SIZE=200）+ 媒体按需。
- 理由：UI 不被网络阻塞、离线可读、改动集中在引导层，业务服务无感。
- 备选：所有读改「先网络后渲染」——延迟与可用性劣化，且要改全部业务服务，不取。

### D3 写路径：本地先写 + ChangeBus + Outbox

- 决策：
  1. 统一变更总线 `services/supabase-sync/change-bus.ts`：
     `emit({entityType, entityId, updatedAt})`。各存储写入点接线——workspace 已有
     observeEvents 六事件直接映射；task / prompt / chat / kb / workflow / graph /
     settings / asset 各写点补 emit。
  2. Outbox 持久化：IndexedDB `aitu-app` 新 store `sync_outbox`，**只记键不记内容**
     （内容仍从本地缓存现读，天然最新）；写入事件先入队、推送成功出队；离线累积，
     恢复在线按序回放。
  3. SyncPusher：订阅总线 → 2s 防抖聚合 → 按 outbox 键集做键级内容收集（依赖
     improve-sync-performance，成本 O(脏实体)）→ upsert 云端 → 出队。
  4. 回放防旧覆新：回放前比对云端 updatedAt，云端较新则丢弃本次回放并记冲突日志。
- 理由：UI 写零延迟、离线可写、崩溃不丢变更（outbox 已持久化）；事件驱动取代 30s
  全量防抖。
- 备选：直写云端（无 outbox）——离线不可写、UI 受网络抖动影响，不取。

### D4 云→端：Realtime 优先，轮询兜底

- 决策：`supabase.channel` 订阅 postgres_changes（table=`user_sync_data`，
  filter=`user_id=eq.{uid}`）→ 收到变更与本地比对（checksum/updatedAt）→ 应用缓存
  + 通知 UI；媒体元数据实体变更后触发 media-sync 拉取二进制。断线/连接失败退化为
  60s lastSync 增量轮询 + visibilitychange 立即 reconcile（现有逻辑保留）。
- 风险前置：自托管 Supabase Realtime 在 HTTP（ws://）的可用性需 Phase D 首项 spike
  验证；若不可用，轮询兜底即最终形态（秒级让位分钟级，功能不缺失）。HTTP 页面加载
  ws:// 无混合内容限制，理论可行，须实测。

### D5 凭据上云：信封加密（密码派生 KEK 包裹 DEK）

- 决策：
  - `secret` 实体单键 `settings_secrets`（凭据集合小，全量覆盖，LWW 冲突语义最简）。
    content = `{ v, kdf:{algo:'PBKDF2-SHA256', iterations:100000, salt}, wrappedDek,
    ciphertext }`；ciphertext = AES-GCM(DEK, 敏感子树 JSON)。敏感子树范围 =
    settings 中被 collector SENSITIVE_KEYS（apiKey/apikey/api_key/secret/token/
    password/_password/apikeyMeta）与 settings-manager SENSITIVE_FIELDS +
    `providerProfiles.*.apiKey` 命中的部分。
  - DEK 随机 256-bit；KEK = PBKDF2(登录密码, salt)。换设备登录时 auth-context 在
    signInWithPassword 处捕获密码 → 解包 DEK → DEK 缓存 localStorage
    （`drawnix_secret_dek`，登出清除）。此后刷新页面免密码。暴露面与 supabase
    refresh token 同级（设备可信模型，如实声明）。
  - HTTP 兜底：引入 `@noble/ciphers`（aes，纯 JS、零依赖、经审计）+ `@noble/hashes`
    （pbkdf2）；subtle 不可用时走纯 JS **真加密**。凭据路径禁止 `aes-gcm.ts` 现有
    OPENTU_FB Base64 明文降级。载荷仅 KB 级，性能无感；PBKDF2 100k 纯 JS 仅登录时一次。
  - 下载合入：apply-remote 解密后按路径注回 settings；settings 实体继续脱敏（双保险，
    现有脱敏代码不动）。
  - 改密码：旧 DEK 在手 → 新盐重派生 KEK 重包裹（rewrap），密文与 DEK 不变。
- 备选：RLS 明文存储——违背凭据上云的安全预期，DB 导出即泄露；服务端 KMS/Vault——
  自托管运维成本高。均不取。
- 已知限制（如实声明）：HTTP 明文传输链路上凭据可被窃听（内网信任模型的既有事实，
  非本变更引入）；DEK 缓存 localStorage，设备被物理接管可解。

### D6 冲突与一致性：沿用 LWW + 画板元素合并

- 决策：不变更现语义（`merge.ts` LWW + `resolveBoardConflict` 元素级合并）；
  updated_at 仍由客户端生成（内网 NTP 偏差可接受；服务端时间戳化列 Open Question）；
  secret 实体 LWW（最后保存的凭据集胜出）；workflow_run 追加型实体按 ID 天然不冲突。

### D7 迁移与兼容

- 存量用户：新增实体云端为空 → 登录 reconcile 时「本地有、云端无」的键自动上推
  （现引擎语义已覆盖），无需专门 migration；本地存储格式零改动（语义降级为缓存），
  无数据迁移。
- 旧客户端混跑：旧客户端的采集/应用按 `SYNC_ENTITY_TYPES` 集合工作，对新类型天然
  忽略（Phase A 需验证「未知类型不致崩溃」：键扫描拉回未知类型行时 apply-remote 跳过）。
- 登出语义：清本地缓存与 DEK（数据在云，公共机器安全）；现行登出行为核查后在
  Phase C 落实。

### D8 媒体面：已是云权威，补按需拉取为标准路径

- 决策：media-sync 的内容寻址上传 + 下载回写保持；元素引用解析 Cache miss →
  按需从 yue-sync 桶拉取回填，从「同步期行为」升级为引用解析的标准路径。

## Risks / Trade-offs

- 云端不可达 ⇒ 写不达云端（本地读写仍可用，outbox 兜底）→ UI 离线徽标明示；
  云端成为唯一真相后建议 Supabase 侧加 pg_dump 定时备份（运维项，提交用户）。
- 冷启动首拉耗时（大账号）→ SWR + 分页 + 媒体按需；无缓存首启显示进度。
- Realtime 自托管/HTTP 可用性未证 → spike 前置，轮询兜底保功能。
- 事件驱动推送频率 ↑ → 依赖键级增量收集使单次成本 O(脏实体)；若
  improve-sync-performance 未先行落地，Phase B 须吸收其引擎改造。
- 时钟偏差影响 LWW → 内网 NTP 假设；可选服务端时间戳（Open Question）。
- 纯 JS 加密性能 → 仅 KB 级载荷 + 登录时一次 PBKDF2，实测验证。

## Migration Plan

- 阶段顺序：**Phase A** 数据面补齐（ChangeBus/outbox 抽象 + 三类新实体采集写回 +
  各写点接线）→ **Phase B** 事件驱动推送 + outbox 回放 → **Phase C** 读路径 SWR
  切换（feature flag `CLOUD_AUTHORITATIVE_READ`）→ **Phase D** Realtime →
  **Phase E** secrets（可与 B-D 并行）。
- 每阶段按仓库工作流交付：本地全量测试 → 前端改动用户过目（含一次非 localhost
  HTTP 访问验证）→ 推送 main 监控流水线全绿 → 用户手动触发部署。
- 回滚：Phase C 起 feature flag 可切回 local-first reconcile；outbox/新实体对旧
  引擎透明（未知类型忽略）；云端无 schema 变更，回滚不涉及数据回迁。

## Open Questions

- 产品是否已有/需要「修改密码」入口 → 决定 DEK rewrap 接线点；暂无入口则改密后
  换设备需「重录凭据」作为兜底说明。
- workflow_run 保留策略默认值（建议：每工作流最近 20 次且 7 天内，云端可再收敛）。
- 服务端 updated_at（DB 触发器统一时钟）是否本次一并引入（提升 LWW 公平性，非必需）。
- Realtime spike 结论决定 Phase D 全量铺开或以轮询收尾。
