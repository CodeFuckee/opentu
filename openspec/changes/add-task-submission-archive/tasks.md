# Tasks: 任务参数 Supabase 归档

## 1. 数据库

- [x] 1.1 新增迁移 `supabase/migrations/task_submissions.sql`：表 + RLS + unique(user_id, task_id) + bucket huabu + storage 对象策略

## 2. 前端 drawnix 包

- [x] 2.1 `core.ts` 纯函数：dataURL 解析/Blob 解码、MIME→扩展名、用户名清洗、存储路径拼接、SHA-256、文件条目提取与去重、参数替换（深拷贝）
- [x] 2.2 `service.ts`：archiveTaskToSupabase（上传 + upsert 入库，静默失败）+ updateTaskSubmissionOnTerminal（终态回写）
- [x] 2.3 `runtime.ts`：configureTaskArchive 注册器 + `runtime.ts` 导出
- [x] 2.4 `task-queue-service.ts`：createTask 后 fire-and-forget 归档（stripLargeParams 之前）+ 终态订阅回写
- [x] 2.5 `package.json` 新增 `@supabase/supabase-js` 依赖

## 3. apps/web 壳层

- [x] 3.1 `auth-context.tsx` 登录态变化时注册/注销归档配置

## 4. 测试

- [x] 4.1 `core.test.ts`：路径/哈希/MIME/解码/替换/清洗/去重/边界（30 用例通过）
- [x] 4.2 `service.test.ts`：未注册/无会话/用户名回退/上传成功与失败/终态回写（12 用例通过）

## 5. 文档与验证

- [x] 5.1 `docs/task-submission-archive.md`（表结构、bucket、部署步骤、验收清单、回滚）
- [x] 5.2 `CHANGELOG.md` 新增条目
- [x] 5.3 前端验证：drawnix vitest 与基线无新增失败（基线既有 16 文件/68 用例环境性失败逐条一致，新增 42 用例全过）；apps/web typecheck / supabase 测试通过