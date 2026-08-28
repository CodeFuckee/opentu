# 任务参数 Supabase 归档（task_submissions + huabu bucket）

## 概述

用户在画布提交 AI 生成任务（图片 / 视频 / 音频 / chat 及各类分析任务）时，
任务参数会异步归档到 Supabase：

- **参数** → 写入 `public.task_submissions` 表（JSONB）
- **文件**（base64 dataURL / File）→ 上传到 Storage bucket `huabu`，
  路径 `{oa账号}/{YYYY-MM-DD}/input-{SHA-256}.{扩展名}`
- **数据库**中保存文件路径：参数里的 dataURL 被替换为存储路径，同时 `file_paths` 记录路径列表
- **URL 引用**（http(s) / `/__aitu_cache__/`）原样保留，不重复上传
- **终态回写**：任务 completed / failed / cancelled 时更新同一行

归档是 fire-and-forget 后台操作：Supabase 不可用、未登录、未注册配置时一律**静默跳过**，
不阻塞任务创建与执行，不向用户报错（仅 console 警告）。

## 数据表

```sql
public.task_submissions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade,
  task_id      text,                 -- 前端任务队列 task.id
  type         text,                 -- image / video / audio / chat / ...
  params       jsonb,                -- 文件字段已替换为存储路径的完整参数
  file_paths   jsonb default '[]',   -- 本次归档上传的文件路径列表
  status       text default 'submitted',  -- submitted | completed | failed | cancelled
  result       jsonb,                -- 完成时补充
  error        jsonb,                -- 失败时补充
  created_at   timestamptz default now(),
  completed_at timestamptz,
  updated_at   timestamptz default now(),
  unique (user_id, task_id)          -- 配合前端 upsert onConflict
)
```

- RLS：用户只能 select / insert / update / delete 自己的行（`auth.uid() = user_id`）
- 表写入仅授权 `authenticated`，不开放给 `anon`

## Storage bucket `huabu`

- 私有 bucket（`public = false`），用于存放任务输入文件
- 对象路径：`{用户名}/{YYYY-MM-DD}/input-{sha256}.{ext}`
  - 用户名 = `user_profiles.oa_account`（缺省回退登录邮箱 @ 前缀），经清洗（小写 + `[^a-z0-9._-]` 替换为 `_`）
  - 日期 = 任务创建当天本地日期（浏览器时区）
  - 哈希 = 文件二进制 SHA-256（十六进制）
  - 扩展名 = 由 MIME 推导（如 image/png → png、image/jpeg → jpg、video/mp4 → mp4、application/pdf → pdf）
- Storage 对象级策略：仅允许用户操作自己 `{oa账号}/` 目录下的对象（校验文件名首段 == 清洗后的邮箱前缀）

## 集成点

| 层 | 文件 | 说明 |
|---|---|---|
| drawnix 纯逻辑 | `packages/drawnix/src/services/task-supabase-archive/core.ts` | dataURL 解析/解码、MIME→扩展名、SHA-256、路径拼接、参数替换 |
| drawnix 服务 | `packages/drawnix/src/services/task-supabase-archive/service.ts` | 上传 + 入库 + 终态回写（静默失败） |
| drawnix 注册器 | `packages/drawnix/src/services/task-supabase-archive/runtime.ts` | `configureTaskArchive(config)` |
| drawnix 挂载 | `packages/drawnix/src/services/task-queue-service.ts` | `createTask` 后 fire-and-forget 归档；终态订阅回写 |
| 宿主注册 | `apps/web/src/supabase/auth-context.tsx` | 登录态变化注册/注销（client + bucket） |
| 依赖 | `packages/drawnix/package.json` | 新增 `@supabase/supabase-js` |

## 部署步骤（自托管 Supabase）

1. **执行数据库迁移**（创建表 + RLS + bucket + storage 策略）：

   ```bash
   docker exec -i supabase-db psql -U supabase_admin -d postgres \
     < supabase/migrations/task_submissions.sql
   ```

   迁移幂等，可重复执行。

2. **验证表与 bucket**：

   ```sql
   select * from public.task_submissions limit 5;
   select id, name, public from storage.buckets where id = 'huabu';
   ```

3. **前端发版**：`packages/drawnix`（归档服务）与 `apps/web`（宿主注册）随正常构建发布。

## 验收清单

1. 登录后（oa账号如 `zhangsan`）在 AI 图片弹窗上传一张 PNG 参考图并点「生成」
2. 等 1-2 秒（归档为异步，无需等待任务完成）：

   ```bash
   docker exec -i supabase-db psql -U supabase_admin -d postgres -c \
     "select user_id, task_id, type, status, file_paths from task_submissions order by created_at desc limit 3;"
   ```

   应能看到 `file_paths` 形如 `["zhangsan/2026-08-28/input-<64位sha256>.png"]`，
   `params` 中对应字段为该路径而非 base64
3. 任务生成完成后，同一行的 `status` 变为 `completed` 且 `result` 非空
4. 刷新页面重开任务队列，任务仍正常（归档不影响 IndexedDB 任务队列）
5. 未登录 / Supabase 不可用时提交任务，任务照常执行，控制台仅出现 `[TaskArchive]` 警告

## 回滚

- 前端：`auth-context.tsx` 去掉 `configureTaskArchive` 注册调用即可停用归档（不影响其他功能）
- 数据库：删除表与 bucket（**注意**会丢失已归档数据）：

  ```sql
  drop policy if exists "task_submissions_select_own" on public.task_submissions;
  drop policy if exists "task_submissions_insert_own" on public.task_submissions;
  drop policy if exists "task_submissions_update_own" on public.task_submissions;
  drop policy if exists "task_submissions_delete_own" on public.task_submissions;
  drop table if exists public.task_submissions;
  -- storage 策略与 bucket（对象数据一并删除）
  delete from storage.objects where bucket_id = 'huabu';
  delete from storage.buckets where id = 'huabu';
  ```

## 注意事项

- 归档在 `stripLargeParams` 之前调用，保证能拿到完整的 base64 参考图；剥离的是 IndexedDB 落盘副本，不影响本功能
- 单个文件上传失败：该 dataURL 原样保留在 `params`、不进 `file_paths`，其余文件与参数仍正常入库
- 相同 dataURL 在参数中出现多次只上传一次（按首次出现的路径替换所有出现位置）
- bucket 为私有，参数中保存的是**存储路径**而非公开 URL；如需对外展示，可后续补 `getPublicUrl` / 签名 URL