# Tasks: add-supabase-cloud-sync

## 1. 数据库
- [x] 1.1 编写 `supabase/migrations/user_sync_data.sql`：`user_sync_data` 表（user_id, entity_type, entity_id, content jsonb, checksum, updated_at, deleted_at, 主键 (user_id, entity_type, entity_id)）+ `set_updated_at` 触发器 + RLS 全部策略
- [x] 1.2 编写 `supabase/migrations/user_sync_media.sql`：`user_sync_media` 表（user_id, url, type, mime_type, size, storage_path, updated_at）+ Storage bucket `yue-sync`（私有）+ 按用户名目录隔离的 storage 策略

## 2. 核心纯函数（测试先行）
- [x] 2.1 设计 `supabase-sync` 类型（entity_type 常量、SyncEntity、同步状态、结果结构）
- [x] 2.2 编写 checksum / 变更比较 / 元素合并 / 删除墓碑的纯函数测试
- [x] 2.3 编写本地数据收集器接口与归一化逻辑测试（各数据源 collectX）
- [x] 2.4 编写同步引擎合并逻辑测试（本地/远程 双端修改、空本地、删除同步）

## 3. 实现
- [x] 3.1 实现 `supabase-sync/types.ts`、`checksum.ts`、`merge.ts`（迁移 data-serializer 纯逻辑）
- [x] 3.2 实现 `supabase-sync/collector.ts`（覆盖 workspace/boards/tasks/workflows/prompts/kb/chat/audio/characters/assets/settings/custom-tools）
- [x] 3.3 实现 `supabase-sync/client.ts`（Supabase 读写封装：upsert/select/soft-delete）
- [x] 3.4 实现 `supabase-sync/media-sync.ts`（Storage 上传/下载 + 元数据表读写 + getCachedBlob 复用）
- [x] 3.5 实现 `supabase-sync/sync-engine.ts`（登录后自动上传 / 增量同步 / 冲突合并 / 自动防抖）
- [x] 3.6 实现 `supabase-sync/runtime.ts`（configureSupabaseSync 注册模式）+ `packages/drawnix/src/runtime.ts` 导出

## 4. UI 接线
- [x] 4.1 新建 `SupabaseSyncContext`（替代 GitHubSyncContext）
- [x] 4.2 改造 `SyncSettings`：登录用户 + 同步状态 + 手动同步/上传/下载
- [x] 4.3 改造 `SyncStatusIndicator` 使用新 context
- [x] 4.4 `auth-context.tsx` 登录后 `configureSupabaseSync({ client })`
- [x] 4.5 移除 Gist 相关 UI 入口与 GitHubSyncProvider 包装

## 5. 废弃 github-sync
- [x] 5.1 删除 `packages/drawnix/src/services/github-sync/` 全部文件
- [x] 5.2 清理所有对 github-sync 的 import（grep 全局检查）

## 6. 验证
- [x] 6.1 运行新增测试全部通过（48 个）
- [x] 6.2 运行全量测试套件无新增回归（失败集与基线一致，均为预存环境问题）
- [x] 6.3 全量 typecheck 通过；新文件 eslint 0 error；web build 通过
  （说明：drawnix lint target 在 Windows 上因 nx shell 脚本 `$?` 解析报 `Invalid option '-n'`，
  基线同样失败——环境问题；GitLab 无可用 CI（auto_devops 关闭、无 .gitlab-ci.yml），
  CI 定义在 .github/workflows/ci.yml（GitHub Actions），本仓库 remote 为 GitLab 不触发，
  已用本地类型检查+构建+测试等价验证）

## 7. 推送与文档
- [x] 7.1 推送 GitLab main（两次提交 8bb8b198 → 1003da7e）
- [x] 7.2 更新 CHANGELOG.md、README.md、README_en.md、docs/cloud-sync.md（同步说明）