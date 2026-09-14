# Tasks: add-remote-model-catalog

## 1. 数据库

- [ ] 1.1 新增 `supabase/migrations/model_catalog.sql`：建表、RLS（anon select）、
      updated_at 触发器、字段注释

## 2. 前端核心

- [ ] 2.1 `model-config.ts`：新增 `setRemoteModelCatalog` / `clearRemoteModelCatalog` /
      `getRemoteModelCatalogModels`，合并链扩展为 remote > runtime > static
- [ ] 2.2 新增 `utils/remote-model-catalog.ts`：行校验与 `ModelConfig` 转换、
      PostgREST 拉取、localStorage 缓存注水/降级、TTL 与订阅通知
- [ ] 2.3 `runtime-model-discovery.ts`：`getSelectableModels` 与
      `getPinnedSelectableModel` 接入远程目录层
- [ ] 2.4 `runtime.ts` 导出 `configureRemoteModelCatalog` / `refreshRemoteModelCatalog`
- [ ] 2.5 `apps/web`：`supabase-client.ts` 导出 anon key；`auth-context.tsx`
      启动时装配并首次拉取（与登录态无关）

## 3. 后台同步

- [ ] 3.1 apps/web 装配：启动首次拉取 + 10 分钟定时刷新 + 标签页回前台刷新
      （全部 TTL 约束、组件卸载时清理；不向用户暴露任何同步入口）

## 4. 测试

- [ ] 4.1 `utils/__tests__/remote-model-catalog.test.ts`：行校验/转换、拉取成功应用、
      非法行跳过、失败回退缓存、无缓存回退静态、TTL 与 force
- [ ] 4.2 `constants/__tests__/model-config.test.ts`：三层合并优先级用例
- [ ] 4.3 本地全量测试（`pnpm test`、`pnpm check`）通过

## 5. 交付

- [ ] 5.1 更新 `CHANGELOG.md`
- [ ] 5.2 启动前端供用户过目确认（含模拟目录数据的验证路径）
