# Design: add-supabase-cloud-sync

## Context
Yue画布（Plait 白板应用）全部用户数据仅存本地浏览器（6 个 IndexedDB 库 + Cache Storage `drawnix-images` + localStorage）。目标：登录 Supabase Auth 后，把全部数据同步到自托管 Supabase（10.37.80.25:8021），跨浏览器/设备同一账号数据一致。已有 GitHub Gist 同步（`github-sync/`）依赖外部 Token 且覆盖不全，将整体废弃。

现有 Supabase 基础（可复用模式）：
- Auth 邮箱密码登录（`apps/web/src/supabase/auth-context.tsx`，AuthGate 挡板）
- `task-supabase-archive/`：运行时注册模式（`configureTaskArchive({client})`，`runtime.ts`），RLS 按 `auth.uid()` 隔离，Storage 按用户名目录策略
- 数据库实践：`set_updated_at()` 触发器、`storage.foldername(name)[1]` 目录隔离、`revoke anon / grant authenticated`

## Goals
- 用户登录后，本地全部数据自动上传云端（首次全量），此后增量同步（手动按钮 + 30s 防抖自动）
- 换设备登录同一账号后，数据自动下载合并到本地（较新优先 + 画板元素级合并）
- 媒体二进制（素材库图片、AI 生成图/视频/音频、画布内图片）存 Supabase Storage，DB 只存元数据
- 完全移除 GitHub Gist 同步依赖

## Non-Goals
- 不做多人实时协作（单账号多设备一致性）
- 不做端到端加密（复用现有 Auth 会话安全边界）
- 不迁移现有 Gist 云端存量数据（Gist 数据不自动导入；用户可选手动导出）

## Decisions

### D1: 通用同步表 user_sync_data
一张表通吃所有实体：`(user_id, entity_type, entity_id, content jsonb, checksum text, created_at, updated_at, deleted_at)`，主键 `(user_id, entity_type, entity_id)`。entity_type 枚举：`board / folder / workspace_state / prompt / prompt_deleted / task / workflow / kb_note / kb_directory / kb_tag / kb_note_tag / kb_note_content / kb_note_image / chat_session / chat_message / audio_playlist / audio_playlist_item / character / asset / cache_media / settings / custom_tools`。
理由：一条记录一个实体 → 行小、增量精确、冲突按实体处理；避免 PostgREST 大 payload。

### D2: 媒体文件 → Storage bucket `yue-sync`
`user_sync_media(user_id, url, type, mime_type, size, storage_path, updated_at)` 主键 `(user_id, url)`，URL 为本地缓存/素材虚拟路径或远程原始 URL。storage_path 形如 `{sanitized-username}/{category}/{sha256}.{ext}`（与 task archive 同规则）。桶私有，storage 策略按 `storage.foldername(name)[1]` 与登录邮箱 @ 前缀（sanitizeUsername 规则）匹配，与 `task_submissions_huabu_*` 策略一致。
二进制读取复用 `unifiedCacheService.getCachedBlob()`；下载后写入 Cache Storage。

### D3: 同步引擎（复用 data-serializer 纯逻辑）
迁移 `data-serializer.ts` 中与 Gist 无关的纯函数到 `supabase-sync/merge.ts`：
- `calculateChecksum`（字符串 hash）
- `mergeBoardElements`（元素级合并）
- `compareBoardChanges`（checksum + updatedAt + lastSyncTime 判定上传/下载/冲突/删除）
- `applySyncData`（应用远程到本地，去 Gist 依赖：保存 folder/board、合并 prompts、任务恢复 `taskQueueService.restoreTasks` + `importTasks`、KB apply）
补齐 chat/audio/characters/assets/settings/custom-tools 的合并原语（这些现在 Gist 版没有）。
新增 `collector.ts` 复用 `collectSyncData` 结构并扩展：workspace/boards/tasks(全状态分页)/workflows/prompts/kb + chat + audio + characters + assets + cache 元数据 + settings（sanitizeObject 去除敏感后）+ custom-tools。

### D4: 运行时注入（同 task-supabase-archive 模式）
`supabase-sync/runtime.ts`：`configureSupabaseSync(config: SupabaseSyncConfig | null)`，config 含 `client: SupabaseClient`。`auth-context.tsx` 登录时注册、登出时清空。引擎通过 config 取 client，不直接依赖 `apps/web`。

### D5: 同步触发
- 登录成功且 `user_sync_data` 无该用户记录（首次）→ 自动全量上传本地
- 非首次 → 登录后自动增量拉取合并（下载远程较新实体、上传本地较新实体）
- 手动：时刻同步按钮 / 上传按钮 / 下载按钮（SyncSettings 内）
- 自动：变更后 30s 防抖自动同步（沿用现有 AUTO_SYNC_DEBOUNCE）
- 冲突：画板元素级合并；其余实体较新优先（updatedAt），checksum 相同跳过

### D6: 删除策略
软删除：实体从本地删除 → 上行标记 `deleted_at`（tombstone）；下载端按 tombstone 删除本地（画板走回收站保护：`performSafetyCheck` 逻辑迁移——首次同步不删、当前画板保护、批量删除警告）。

## Risks / Trade-offs
- **首次全量上传体积大**（上千任务 + 数百媒体）→ 分批 + `yieldToMain()` 分片上传，媒体顺序队列
- **RLS 误配置导致数据不可见/泄露** → 同步表策略先 revoke anon、grant authenticated，`auth.uid() = user_id` 四操作齐全；Storage 桶私有
- **自托管实例可用性**（10.37.80.25:8021）→ 同步失败不阻塞本地使用，状态指示器显示 error
- **媒体去重**：按内容 SHA-256 路径天然去重；`user_sync_media` 按 (user_id, url) 主键防重复
- **旧 Gist 数据不回迁** → README 说明导出方式

## Migration Plan
1. 先建 SQL（表 + 触发器 + RLS + bucket）——对线上实例执行 `docker exec ... psql`（用户确认后）
2. 前端模块 + 测试先行，全量测试通过后接线 UI
3. 删除 github-sync，再跑全量测试
4. 推送 GitLab，CI success 后更新文档
- Rollback：新表不影响现有功能；github-sync 代码删除前先确保新引擎可用（git 历史可回退）

## Open Questions
- 待确认：`user_sync_data` 是否需要对 `entity_type` 建部分索引（默认 (user_id, entity_type, entity_id) 主键已覆盖增量查询）
- 待确认：settings 同步是否只同步非敏感字段（API Key 不传云端，避免泄露）