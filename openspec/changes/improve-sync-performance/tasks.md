# Tasks: improve-sync-performance

> 进度注记（2026-10-12）：批次 1（阶段计时）/2（CI 数据治理）/3（远程拉取增量化，
> 含增量墓碑缺口补齐与边界单测）完成。批次 4（本地收集增量化）**暂缓**：
> IndexedDB 记录读取无列裁剪，「键扫描」仍会读全部字节，收益存疑——待批次 1 的
> stageTimings 数据确认 collectMs 实际占比后再决定是否实施。

## 批次 1：阶段计时（可观测先行）

- [x] 1.1 runSync 各阶段计时（collectMs/remoteFetchMs/diffMs/uploadMs/downloadMs/
      totalMs）加入返回结果
- [x] 1.2 SupabaseSyncContext 同步完成后输出阶段耗时日志
- [x] 1.3 单测：stageTimings 字段与数值合理性

## 批次 2：E2E 数据治理

- [x] 2.1 test:e2e job 前置清理 e2e_sync_% 账号 user_sync_data（psql，宿主机执行）

## 批次 3：远程拉取增量化

- [x] 3.1 repository 新增键扫描（轻列分页）fetchRemoteEntityKeys
- [x] 3.2 fetchRemoteEntities 加 updated_at 窗口过滤（lastSync null = 全量）
- [x] 3.3 引擎 knownRemoteKeys 改用键扫描；窗口内容供 diff
- [x] 3.4 单测：墓碑入窗/首同步全量/窗口外不变更不拉/knownRemoteKeys 全量语义

## 批次 4：本地收集增量化

- [ ] 4.1 local-collector 键扫描（type,id,updated_at 轻扫）与内容按需构建分离
- [ ] 4.2 引擎按 diff 需要回查脏实体内容
- [ ] 4.3 单测：本地墓碑边界（键缺失+knownRemoteKeys 含键 → toTombstoneRemotely）/
      脏实体内容构建正确性

## 批次 5：验收

- [ ] 5.1 全量单测 + typecheck + lint
- [ ] 5.2 本地 cloud-sync 簇 E2E 跑绿（含二次同步增量化路径）
- [ ] 5.3 阶段计时日志对照（增量 vs 首同步）
- [ ] 5.4 CHANGELOG + 过目 + 推送 + 流水线全绿
