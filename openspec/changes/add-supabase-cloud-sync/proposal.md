# Change: 将本地数据迁移到 Supabase 实现云端同步

## Why
目前所有用户数据（画板、任务、工作流、提示词、知识库、聊天、音频、角色、素材库、设置）只保存在本地浏览器（IndexedDB / Cache Storage / localStorage），换浏览器、换设备后看不到之前的记录。项目已有 GitHub Gist 同步，但依赖用户提供 GitHub Token，且覆盖范围不完整（缺聊天/音频/角色/素材/设置）。目标是改为使用项目已有的 Supabase Auth 账号体系，将全部本地数据同步到自托管 Supabase（10.37.80.25:8021），实现跨浏览器/设备登录同一账号后看到相同数据。

## What Changes
- **新增** `supabase-sync/` 服务模块：本地数据收集器（覆盖全部数据源）、同步引擎（登录后自动上传 + 手动/自动增量同步 + 较新优先冲突合并）、媒体同步（Supabase Storage 存二进制、DB 存元数据 + 素材库图片）
- **新增** Supabase SQL migration：`user_sync_data` 通用同步表（user_id + entity_type + entity_id + content jsonb + checksum + updated_at + deleted_at）、`user_sync_media` 媒体表、Storage bucket `yue-sync`、全部 RLS 按 auth.uid() 隔离
- **替换** UI：`SupabaseSyncContext` 替代 `GitHubSyncContext`；`SyncSettings`/`SyncStatusIndicator` 改用新引擎（登录用户 + 同步状态 + 手动同步），登录后自动触发首次全量上传
- **废弃删除**：`github-sync/` 模块全部文件及 Gist 相关 UI 入口（一步到位，符合断舍离）

## Impact
- Affected specs: `cloud-sync`（新增能力）
- Affected code:
  - `packages/drawnix/src/services/supabase-sync/*`（新增）
  - `packages/drawnix/src/services/github-sync/*`（删除）
  - `packages/drawnix/src/contexts/GitHubSyncContext.tsx`（替换为 SupabaseSyncContext）
  - `packages/drawnix/src/components/sync-settings/*`、`sync-status/*`（改造）
  - `apps/web/src/supabase/auth-context.tsx`（登录后注册同步配置）
  - `packages/drawnix/src/runtime.ts`（导出 configureSupabaseSync）
  - `supabase/migrations/*`（新增 SQL）
- 复用不删除：`data-serializer.ts` 中的合并/比较/应用纯逻辑迁移到新模块（`mergeBoardElements`/`compareBoardChanges`/`applySyncData` 等去 Gist 化）