## 1. 前置与基建（Phase A 起点）

- [ ] 1.1 确认 `improve-sync-performance`（键全量+内容增量）已落地；未落地则纳入本变更先行实施（键级收集是事件驱动推送的成本前提）
- [ ] 1.2 新建统一变更总线 `services/supabase-sync/change-bus.ts`：类型化事件 `{entityType, entityId, updatedAt}` 的 emit/subscribe + 单测
- [ ] 1.3 Outbox 持久化：`aitu-app` 新 store `sync_outbox`（只记键）+ 入队/出队/回放/清理 API + 单测

## 2. 数据面补齐（Phase A）

- [ ] 2.1 `graph-storage` 写点接 ChangeBus；local-collector 采集 `workflow_graph`；apply-remote 支持写回（覆盖 flowgram 编辑器图数据）
- [ ] 2.2 （推迟：workflow-run-service.ts 有 flowgram 未提交改动，待该流提交后落地）编排运行记录落盘：`workflow-run-service` 快照写入 IndexedDB + 保留策略（建议每工作流最近 20 次且 7 天内）+ `workflow_run` 实体采集/写回
- [ ] 2.3 （已被「跨设备真删除」取代：delete-local 补 prompt/workflow_graph/audio/asset 删除 case，场景等价实现）`prompt_deleted` 墓碑：采集 `aitu_prompt_deleted_contents` → 上传墓碑；apply-remote/delete-local 补删除应用逻辑
- [ ] 2.4 旧客户端兼容验证：键扫描拉回未知 entity_type 行时 apply-remote 安全跳过（不崩溃）+ 单测
- [ ] 2.5 各存储写入点接 ChangeBus（task / prompt / chat / kb / workflow / settings / asset / character）+ 单测
- [ ] 2.6 `supabase/migrations/user_sync_data.sql` entity_type 注释更新（无 CHECK 约束，无 schema migration）

## 3. 写路径事件驱动 + Outbox（Phase B）

- [ ] 3.1 SyncPusher：订阅 ChangeBus → 2s 防抖聚合 → 按 outbox 键集键级收集内容 → upsert 云端 → 出队
- [ ] 3.2 Outbox 回放：应用启动/恢复在线时按序回放；回放前比对云端 updatedAt 防旧覆新，冲突记日志
- [ ] 3.3 失败重试（指数退避）+「离线，N 条待同步」状态徽标（复活挂载 `SyncStatusIndicator`）
- [ ] 3.4 `SupabaseSyncContext` 改造：移除 30s 全量防抖主路径，保留登录 reconcile 与切后台兜底；手动按钮保留为救急入口
- [ ] 3.5 （单测已覆盖回放/断网语义；端到端 E2E 待跑）E2E：断网编辑画板/保存提示词 → 恢复联网自动回放上云

## 4. 读路径云权威切换（Phase C）

- [ ] 4.1 启动 SWR：登录后先渲染本地缓存，后台 lastSync 窗口 reconcile，完成按 diff 刷新 UI
- [ ] 4.2 冷启动（无缓存）加载进度态；缓存未命中实体按需拉取回填
- [ ] 4.3 feature flag `CLOUD_AUTHORITATIVE_READ`（可回退 local-first reconcile）
- [ ] 4.4 登出语义：清本地缓存与 DEK（数据在云），公共机器安全
- [ ] 4.5 E2E：新设备（清空存储）登录后画板/任务/提示词/聊天/KB/设置完整恢复

## 5. Realtime 实时推送（Phase D）

- [ ] 5.1 Spike：自托管 Supabase Realtime 在 HTTP（ws://）可用性验证；结论决定铺开或轮询收尾
- [ ] 5.2 订阅 postgres_changes（user_id 过滤）→ 实体与本地 checksum/updatedAt 比对 → 缓存失效刷新 + UI 通知
- [ ] 5.3 断线退化：60s lastSync 增量轮询 + visibilitychange 立即 reconcile
- [ ] 5.4 媒体元数据实体变更 → 触发 media-sync 拉取二进制
- [ ] 5.5 E2E：双 context 模拟双设备，A 修改 B 秒级可见

## 6. Secrets 凭据上云（Phase E，可与 3–5 并行）

- [ ] 6.1 引入 `@noble/ciphers` + `@noble/hashes`；加密模块增加纯 JS AES-GCM/PBKDF2 兜底（subtle 不可用时真加密）；凭据路径禁用 Base64 明文降级
- [ ] 6.2 `secrets-keyring` 模块：DEK 生成/信封包裹（KEK=PBKDF2(密码,salt,100k)）/localStorage DEK 缓存/登出清除/改密 rewrap + 单测（含跨 realm 兼容）
- [ ] 6.3 `auth-context` 登录/注册流程接入：密码捕获 → 首次生成 DEK 或解包既有 DEK
- [ ] 6.4 `secret` 实体上传（settings 敏感子树加密打包，实体键 `settings_secrets`）与下载合入（apply-remote 解密按路径注回 settings；现有 settings 脱敏保持双保险）
- [ ] 6.5 单测 + E2E：换设备登录 API Key 自动恢复；云端行导出无密码不可还原（静态防泄露验证）

## 7. 收尾

- [ ] 7.1 本地全量测试全绿（受影响子项目全部测试簇）
- [ ] 7.2 E2E 覆盖非 localhost HTTP 访问路径（仓库 AGENTS.md 硬约束）
- [ ] 7.3 用户手册 / CHANGELOG / README 更新（含「云端权威」语义与离线行为说明）
- [ ] 7.4 性能验证：事件驱动单次推送耗时与总数据量无关（键级收集生效）；纯 JS PBKDF2 登录时耗实测
