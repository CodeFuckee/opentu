# Design: remove-local-persistence

## Context

现行架构（refactor-cloud-native-sync 已落地 Phase A–D 核心）：本地 IndexedDB/Cache 为读缓存＋写入口，云端 Supabase 为同步载体，二者经 reconcile（增量窗口＋diff＋元素级合并＋墓碑）对账，写路径走 ChangeBus→Outbox→SyncPusher。复杂度集中在「两份副本如何对齐」。本变更消灭第二份持久化副本，把问题从「对齐两份数据」简化为「单副本上的读写」。

约束：
- HTTP 明文内网部署（非 secure context）：不能依赖 `crypto.subtle`；secret 加密走纯 JS 兜底（@noble/ciphers，Phase E 不变）。
- Supabase 自托管于内网，LAN RTT 小（毫秒级），云端直连的读写延迟可接受；但断网＝完全不可用，用户已接受该单点。
- 用户规模以单用户多设备为主，画板并发编辑频率低——整板粒度足够。
- 媒体二进制不适合进 Postgres：维持 Storage 桶 `yue-sync` ＋ 元数据表 `user_sync_media`（已是云权威＋Cache 性能缓存形态，零改动）。

## Goals / Non-Goals

- Goals：单一事实源（云端 Postgres）；删除全部双向同步与冲突合并代码；冷启动与读写链路心智简化；CAS 防静默覆盖。
- Non-Goals：离线编辑能力；元素粒度并发或多人实时协同（CRDT）；媒体层改造；secret 加密实现（Phase E 独立推进）。

## Decisions

- **D1 持久层边界**：云端 Postgres 唯一持久层；会话内存为唯一工作副本。浏览器侧仅允许三类非权威本地状态：Cache API 媒体性能缓存、Service Worker 静态资源缓存、localStorage 瞬态键（关闭快照、会话、UI 偏好、DEK 缓存）。审计任务确保 localforage 实例全部移除或降级为纯瞬态缓存。
- **D2 并发语义＝整板 LWW＋CAS**：保存时 `.update(...).eq('user_id',uid).eq('entity_type',t).eq('entity_id',id).eq('updated_at', baseUpdatedAt)`，返回 0 行即冲突 → 不覆盖、提示刷新。PostgREST 条件更新原生支持，无需 RPC。Alternatives：元素行存储（多设备编辑体验更好，但 schema/保存/加载全重做，本期否决，保留为演进路径）；CRDT（工程量与「简化」目标相悖，否决）。
- **D3 服务端统一时钟**：`updated_at` 改由 Postgres 触发器 `before insert or update` 生成（`now()`），客户端不再自带时间戳——CAS 的正确性依赖时钟单调且不可伪造。小 migration，顺带消除多设备时钟漂移问题。
- **D4 写路径**：沿用现有防抖节奏（画布防抖保存 + 各存储写点），防抖到点直写云端；失败：内存保留＋「未同步」徽标＋指数退避重试（简化自 sync-pusher，不持久化队列）；`beforeunload` 尽力 flush；关闭快照兜底崩溃/意外关闭。删除 ChangeBus/Outbox/mutex（单写者直连后无交错问题）。
- **D5 读路径**：冷启动＝登录→拉 folder＋board 元数据＋workspace_state（一次按键扫描）→按需拉当前板内容→渲染；删除 `waitForFirstReconcile`、冷启动种板特判、SWR 后台校准。`apply-remote` 精简为「实体→内存模型」加载器供读路径复用。
- **D6 删除语义**：真 DELETE，无墓碑。云端唯一副本，删除即全端删除。
- **D7 多设备感知**：Realtime postgres_changes 订阅保留（infra.ts 不动）；事件到达→定向重拉该实体→未脏自动刷新 / 脏则提示；Realtime 不可用沿用 60s 轮询兜底。
- **D8 存量迁移**：切换版本首次运行时强制一次「全量收集本地→上推云端→确认」收口（沿用 local-collector 一次），随后本地持久化代码整体删除。双端已实时同步数周，实际残留风险低。

## Risks / Trade-offs

- 断网完全不可编辑（用户已接受）→ 连接状态徽标＋明确错误提示，不做静默降级。
- 每次启动/切板走网络 → 内网 RTT 小；沿用启动进度条与骨架屏；超大画板 JSON 整板传输与现状（同步引擎整板 upsert）同量级，无回归。
- 防抖窗口内意外关闭丢编辑 → 关闭快照＋beforeunload flush 双保险；残余窗口极小且提示恢复（沿用现状提示语）。
- CAS 冲突提示在双端交替编辑时可能打断心流 → 本期接受；若实测频繁，演进路径为元素行存储（D2 已留）。
- Supabase 单点 → 建议配套 pg_dump 定时备份（运维项，不在本变更代码范围）。

## Migration Plan

1. 落 DB migration（updated_at 触发器）——向后兼容，先行部署。
2. feature flag `cloud_only_storage`（默认关）：开＝云端直连读＋防抖直写＋CAS；关＝现行 SWR 路径。灰度实测（含 HTTP 非 localhost、LAN IP 访问）。
3. 首次开启时执行 D8 存量收口。
4. 稳定后删除旧路径与 flag（本变更收尾任务）。
回滚：关 flag 即回现行路径；DB migration 对旧路径无影响（updated_at 值源变化对 LWW 语义兼容）。

## Open Questions

- kv-storage/localStorage 中数据性键的完整清单（实施期审计产出，见 tasks 1.1）。
- `color-history-service`、`character-avatar-cache-service` 属数据还是瞬态缓存——审计后定（倾向：色板历史迁云，头像 blob 留 Cache）。
- 关闭快照在云直连下的保留时长（现状：下次打开比对后清除）。
