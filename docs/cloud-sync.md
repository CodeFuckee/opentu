# 云同步（user_sync_data + user_sync_media + yue-sync bucket）

## 概述

登录 Supabase 账号后，Yue画布 会把全部本地数据同步到云端，实现跨浏览器/设备看到同一份记录：

- **画板 / 文件夹 / 工作区状态** → `user_sync_data`（`entity_type='board' | 'folder' | 'workspace_state'`）
- **AI 生成任务 / 工作流 / 提示词** → `user_sync_data`（`task | workflow | prompt`）
- **知识库（目录/笔记/标签/正文/图片）** → `user_sync_data`（`kb_*`）
- **聊天会话与消息 / 音频播放列表 / AI 角色** → `user_sync_data`
- **素材库元数据 / 缓存媒体元数据** → `user_sync_data`（`asset | cache_media`）
- **设置（脱敏）/ 自定义工具** → `user_sync_data`（`settings | custom_tools`）
- **媒体二进制**（素材库图片、AI 生成图/视频/音频、画布内图片） → Storage bucket `yue-sync`
  （私有），元数据写 `user_sync_media`

同步是 **fire-and-forget 后台操作**：Supabase 不可用、未登录、未注册配置时静默跳过，
不阻塞本地使用。

## 同步行为

- **首次登录**：云端无该用户记录 → 自动上传本地全量数据（画板/任务/提示词/工作流/知识库/
  聊天/音频/角色/素材/设置/自定义工具）
- **换设备登录**：自动下载云端数据合并到本地（画板做**元素级合并**，其余实体**较新优先**）
- **增量同步**：按实体 `updated_at` 与内容校验和（checksum）判断上传/下载，未变更不重复传输
- **删除同步**：本地删除 → 云端标记 `deleted_at`（墓碑 tombstone）→ 其他设备同步后删除本地副本
  （画板删除有安全保护：首次同步不删、当前画板保护、批量删除警告）
- **自动同步**：画板/文件夹变更后 30 秒防抖自动同步；页面隐藏时若有待同步变更也会触发
- **手动同步**：同步设置面板提供「立即同步 / 上传本地 / 下载远程」按钮

## 数据库表

```sql
public.user_sync_data (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  entity_type text        not null,   -- board|folder|workspace_state|prompt|task|workflow|kb_*|chat_*|audio_*|character|asset|cache_media|settings|custom_tools
  entity_id   text        not null,   -- 实体主键
  content     jsonb       not null,   -- 实体内容（不含二进制）
  checksum    text        not null,   -- 内容校验和（增量判断）
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,            -- 软删除墓碑
  primary key (user_id, entity_type, entity_id)
)

public.user_sync_media (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  url          text        not null,   -- 本地虚拟路径或远程 URL
  type         text        not null,   -- image|video|audio
  mime_type    text,
  size         bigint,
  storage_path text        not null,   -- {用户名}/{类型}/{sha256}.{ext}
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, url)
)
```

Storage bucket `yue-sync`（私有）：对象路径 `{sanitized-username}/{image|video|audio}/{sha256}.{ext}`，
按内容哈希天然去重。

## 部署

在自托管 Supabase 实例上执行（按顺序）：

```bash
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_sync_data.sql
docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_sync_media.sql
```

- RLS：用户只能读写自己的行（`auth.uid() = user_id`）；匿名角色无权访问
- Storage 策略：按 `storage.foldername(name)[1]` 与登录邮箱 @ 前缀（`sanitizeUsername` 规则，
  小写 + `[^a-z0-9._-]` 替换为 `_`）匹配，与 `task_submissions_huabu_*` 策略一致
- `user_profiles.oa_account` 存在时优先作为用户名目录，缺失回退邮箱 @ 前缀

## 代码结构

- `packages/drawnix/src/services/supabase-sync/`
  - `checksum.ts` 内容校验和 + 实体键 + yieldToMain
  - `merge.ts` 变更比较 / 元素级合并 / 冲突解决（迁移自 github-sync，去 Gist 化）
  - `collector-core.ts` 收集器接口与聚合（纯函数，可单测）
  - `local-collector.ts` 真实数据源收集（画板/任务/工作流/提示词/知识库/聊天/音频/角色/素材/设置/工具）
  - `repository.ts` Supabase 读写封装（user_sync_data / user_sync_media 分页拉取、批量 upsert、软删除）
  - `apply-remote.ts` 下载侧应用（云端实体 → 本地各数据源）
  - `delete-local.ts` 墓碑下载侧删除（含画板删除安全保护）
  - `media-sync.ts` 媒体同步（Storage 上传/下载）
  - `media-sync-adapter.ts` 素材库/任务队列复用的媒体状态接口
  - `runtime.ts` 运行时注册（`configureSupabaseSync`）
  - `sync-engine.ts` 同步引擎（依赖注入，可单测）
  - `log.ts` 日志（复用 unified-log）
- `packages/drawnix/src/contexts/SupabaseSyncContext.tsx` 全局同步状态与操作
- `apps/web/src/supabase/auth-context.tsx` 登录后注册同步配置

## 说明

- **设置同步会脱敏**：上传前 `sanitizeObject` 过滤 API Key / Token / 密码等敏感字段
- **素材/媒体同步**：本地二进制经 `unifiedCacheService.getCachedBlob()` 读取后上传；
  下载后写回 Cache Storage；素材库、任务队列中的「同步到云端」按钮走同一通道
- **GitHub Gist 同步已废弃**：`github-sync/` 模块与 Gist UI 入口已移除，
  同步设置现基于 Supabase 登录账号