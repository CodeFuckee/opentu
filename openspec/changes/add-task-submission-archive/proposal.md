# Change: 任务参数 Supabase 归档（huabu bucket + task_submissions 表）

## Why

当前 AI 生成任务的参数只存浏览器 IndexedDB（SW 模式），格式大字段（base64 参考图）会被剥离，
服务器侧没有任何任务参数留档；用户"生成的图片提交"的输入文件也无处追溯。
需要把任务参数沉淀到 Supabase，文件上传到 Storage bucket，数据库保存文件路径。

## What Changes

- 新增数据库表 `task_submissions`（RLS：用户只能读写自己的行；user_id+task_id 唯一，配合前端 upsert）
- 新增 Storage bucket `huabu`（私有）+ 对象级策略：用户只能操作自己 `{oa账号}/` 目录下对象
- 新增前端归档服务 `packages/drawnix/src/services/task-supabase-archive/`：
  - 任务创建时 fire-and-forget 归档参数（status=submitted）
  - 参数中 base64/File 形式的文件上传到 `{oa账号}/{YYYY-MM-DD}/input-{SHA-256}.{ext}`，
    参数中的 dataURL 替换为存储路径；http/`__aitu_cache__` URL 原样保留
  - 终态回写同一行：completed→result、failed→error、cancelled
  - 全程静默失败，不阻塞任务执行
- 宿主 apps/web 登录态变化时注册/注销归档配置（官方 `@supabase/supabase-js` client）
- 用户名取 `user_profiles.oa_account`，缺省回退登录邮箱 @ 前缀

## Impact

- Affected specs:
  - 无现有 spec 覆盖此能力（新增 `task-submission-archive` capability）
- Affected code:
  - `supabase/migrations/task_submissions.sql`（新增：表 + RLS + bucket + storage 策略）
  - `packages/drawnix/src/services/task-supabase-archive/`（新增：core.ts / service.ts / runtime.ts + 测试）
  - `packages/drawnix/src/services/task-queue-service.ts`（createTask 归档 + 终态订阅）
  - `packages/drawnix/src/runtime.ts`（导出 configureTaskArchive）
  - `packages/drawnix/package.json`（新增 `@supabase/supabase-js` 依赖）
  - `apps/web/src/supabase/auth-context.tsx`（注册/注销归档配置）
  - `docs/task-submission-archive.md`（新增：部署步骤与验收清单）