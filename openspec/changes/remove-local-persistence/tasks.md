# Tasks: remove-local-persistence

## 1. 审计与前置
- [x] 1.1 盘点 IndexedDB（localforage 全部实例、`aitu-app` 库）与 kv-storage/localStorage 数据性键，产出「迁云/删/留瞬态」三栏清单（design.md D1 边界）→ 见本目录 audit.md
- [x] 1.2 DB migration：`user_sync_data` 增 `before insert or update` 触发器统一生成 `updated_at`；确认 `entity_type` 无 CHECK 约束无需结构变更 → `supabase/migrations/user_sync_data_server_clock.sql`（**待用户在自托管 Supabase 执行**）
- [x] 1.3 `repository.ts` 增加条件更新（`.eq('updated_at', base)` CAS，返回命中行数）与真删除（DELETE）封装，附单测 → repository-cas.test.ts 7 例

## 2. 数据面云端直连（按依赖顺序逐面切换，每面带 feature flag `cloud_only_storage`）
- [x] 2.1 画板面先行：workspace-storage-service / workspace-service 读改「云端拉取→内存」、写改「防抖直写＋CAS」；删除本地持久化写入（flag 分流，关闭路径零变化）
- [x] 2.2 冷启动链路重写（apps/web/src/app/app.tsx initialize）：登录→拉树→拉当前板→渲染；flag 分支删除 `waitForFirstReconcile` 依赖、种板特判简化为「云端确无画板时创建默认板」（旧路径保留给 flag off）
- [x] 2.3 aitu-app 任务/工作流 store 迁 `user_sync_data`（task/workflow 实体已有；**config store 顺延 Phase E**——其内容为 API Key 等敏感凭据，按 design 须走 secret 信封加密，明文上云是安全倒退）
- [x] 2.4 KB（6 store，经 instrumentKbStore Proxy 单点分流）/chat（2 store）/prompt（kv）/character/audio-playlist/color-history（新实体类型 color_history）/toolbox/kv 数据键（新实体类型 kv_data，提示词历史/外部技能/工具栏配置/自定义渐变/最近颜色/模型跑分，kv-storage-service 单点分流）已切换；**settings-manager 与 asset-storage 三期已切**（settings：非敏感字段上云、敏感留本地待 Phase E；asset：21 触点收敛 5 原语分流）
- [x] 2.5 编排图 `workflow_graph` 上云（graph-storage 四函数分流；**`workflow_run` 顺延**——workflow-run-service.ts 存在另一项工作的未提交改动，待其合入后接同一模式；编排运行记录现仍走 kv）
- [x] 2.6 写失败语义：内存保留＋「未同步」提示＋指数退避重试；beforeunload 尽力 flush；关闭快照兜底保留（机制落在 cloud-direct-store，各面切换即继承）
- [x] 2.7 删除语义改真 DELETE（画板面已切；其余面随 2.3-2.5 切换继承），移除墓碑下载侧与 `deleted_at` 判断（新路径不再写墓碑；旧引擎文件随 4.x 清理）

## 3. 并发与多设备
- [x] 3.1 画板保存接 CAS：冲突（0 行命中）→ 提示「画板已在其他窗口/设备修改，请刷新」＋保留内存态＋暂停该板自动保存（切板解除）
- [x] 3.2 Realtime 定向重拉：postgres_changes 事件→归一化→失效缓存→未脏自动刷新/脏则提示；沿用 60s 键扫描轮询兜底（cloud-direct-runtime.ts）
- [x] 3.3 会话内读缓存（内存 Map）与失效策略：本端写入更新基线、远端事件失效内容、自写回声抑制

## 4. 退役清理（flag 稳定后）
- [ ] 4.1 删除 supabase-sync 中 sync-engine / reconcile / merge / outbox / local-collector / delete-local 及测试；checksum 仅留键工具；sync-mutex 简化
- [ ] 4.2 移除 localforage 依赖与全部 IndexedDB 实例（按 audit.md 清单）；卸载 `localforage` npm 依赖
- [ ] 4.3 移除 feature flag 与旧读写路径；登出语义更新（清内存＋瞬态键即可，数据安全由云端承担）

## 5. 质量门禁
- [x] 5.1 单测：CAS 命中/冲突、直写重试、真删除、投影退化（新增 21 例；全仓 typecheck + drawnix 1715 例通过）
- [x] 5.2 E2E：`cloud-only-storage.spec.ts` 3 例（冷启动直拉渲染 / 受控外部修改构造 CAS 冲突提示 / 断网「未同步」→ 恢复重试落云）；E2E 实测暴露并修复伪冲突自愈缺口与防抖保存吞错（见 CHANGELOG）
- [ ] 5.3 HTTP 非 localhost（LAN IP）实测通过（项目部署红线）
- [ ] 5.4 CHANGELOG.md / README / user-manual 同步更新（CHANGELOG 已更；user-manual 待 flag 默认开启时随 4.x）

## 6. 收尾
- [ ] 6.1 存量收口确认：全量上推一次并核对实体计数后，本地持久化代码归零
- [ ] 6.2 归档顺序执行：先 `refactor-cloud-native-sync` 后本变更（openspec archive）
