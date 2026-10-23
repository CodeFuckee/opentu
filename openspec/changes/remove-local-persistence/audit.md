# 审计清单：浏览器本地持久化数据面盘点（tasks 1.1）

结论口径：**迁云**＝切到 `user_sync_data` 云端直连；**留瞬态**＝非数据副本，保留；
**删**＝随旧同步机制退役。本期（flag `cloud_only_storage`）切画板面，其余数据面按批次跟进。

## IndexedDB（localforage 实例）

| 实例 | 位置 | 数据 | 处置 | 批次 |
| --- | --- | --- | --- | --- |
| folders/boards/state | workspace-storage-service.ts:188-210 | 画板/文件夹/工作区状态 | **迁云（本期）** | 2.1 |
| aitu-app: tasks/workflows/config | app-database.ts | 任务/工作流/配置 | 迁云 | 2.3 |
| kb 6 store（directories/notes/tags/noteTags/noteContents/noteImages） | knowledge-base-service.ts:64-89 | 知识库 | 迁云（kb_* 实体已有） | 2.4 |
| chat sessions/messages | chat-storage-service.ts:14-19 | 聊天 | 迁云（chat_* 实体已有） | 2.4 |
| character | character-storage-service.ts:18 | AI 角色 | 迁云 | 2.4 |
| playlist/playlistItems | audio-playlist-service.ts:24-31 | 音频播放列表 | 迁云 | 2.4 |
| asset store | asset-storage-service.ts:185 | 素材元数据（blob 在 Cache API） | 迁云（元数据） | 2.4 |
| colorHistory | color-history-service.ts:49 | 色板历史（数据性） | 迁云（或降级瞬态，倾向迁云） | 2.4 |
| avatar blob 缓存 | character-avatar-cache-service.ts:14 | 头像二进制缓存 | **留瞬态**（纯缓存） | — |
| kb 提取聊天缓存 | kb-knowledge-extraction/chat-storage.ts:8 | 提取过程缓存 | 审计后倾向**留瞬态** | — |
| 通用 store | storage-service.ts:31 | 待逐键审计 | 待审计 | 2.4 |
| 埋点缓存 | tracking/tracking-storage-service.ts:24 | 埋点批量缓冲 | **留瞬态** | — |
| 导出临时 store ×2 | workspace-export-service.ts:479,502 | 导出打包临时 | **留瞬态**（操作型） | — |
| legacyStore | workspace-migration.ts:24 | 旧版库迁移读取 | **留**（迁移路径，最终随 cleanup 删） | 4.x |
| 备份 restore/export | backup-restore/*.ts | 备份操作临时实例 | **留瞬态**（显式备份动作） | — |

## IndexedDB（手写连接）

| 库 | 位置 | 数据 | 处置 |
| --- | --- | --- | --- |
| KEY_VALUE_STORE.data | kv-storage-service.ts | 见下表 | 逐键 |
| aitu-app | app-database.ts | tasks/workflows/config | 迁云（2.3） |

## kv-storage-service 键

| 键 | 数据 | 处置 |
| --- | --- | --- |
| 自定义渐变（CUSTOM_GRADIENTS_KEY） | 用户数据 | 迁云（settings 类） |
| 最近颜色（RECENT_COLORS） | 用户偏好 | 迁云或降级瞬态 |
| 批量生图缓存（BATCH_IMAGE_CACHE_KEY） | 瞬态缓存 | **留瞬态** |
| external-skill 包 | 用户数据 | 迁云 |
| 工具栏配置 | 用户偏好 | 迁云 |
| 模型跑分状态 | 用户数据 | 迁云 |
| workflow record-storage（kv 运行记录） | 运行记录 | 由 2.5 workflow_run 承接 |
| supabase_sync_last_sync | 同步基线 | **删**（随旧引擎退役） |

## localStorage（非 IndexedDB，参照 design D1 边界）

| 键 | 数据 | 处置 |
| --- | --- | --- |
| BOARD_CLOSE_SNAPSHOT | 关闭前画布快照 | **留瞬态**（崩溃安全网） |
| supabase auth 会话 / DEK 缓存 | 会话凭据 | **留**（既有安全模型） |
| supabase_sync_disable_cloud_reconcile | e2e 隔离开关 | **留** |
| cloud_only_storage（本变更新增 flag） | 灰度开关 | **留**（4.x 删） |

## 备注

- 媒体二进制不在 IndexedDB（Cache API `drawnix-images`），本就云权威＋缓存形态，零改动。
- 上表「迁云」项在未切换批次期间继续走本地（flag 关闭路径），行为与现状一致。
