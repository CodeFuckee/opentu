# Change: 云端模型目录（Supabase model_catalog 表驱动的模型上架）

## Why

当前新增模型必须修改静态配置代码（`model-config.ts` 等多个文件）、走全量测试和发版，
周期以天计；而上游网关侧早已可用。需要一个"不发版上架同协议新模型"的运营通道，
把模型目录级配置（列表展示、默认参数、排序、启停）从代码中解耦出来，由 Supabase 表驱动。

## What Changes

- Supabase 新增 `public.model_catalog` 表：模型 ID、类型、厂商、展示名、默认参数、
  推荐分、启停标记等；RLS 允许匿名读、仅 service_role 可写
- 前端新增远程模型目录模块：应用启动时后台拉取启用条目，经 schema 校验
  转换为 `ModelConfig`，成功后全局生效并缓存到 localStorage；失败时回退缓存，
  缓存也不可用时保持静态内置目录不变；另有定时与回前台触发的 TTL 约束刷新
- 目录接管语义：表内有生效条目时表是唯一事实源，静态内置目录退位
  （管理员停用/删除模型不会被静态兜底复活）；目录为空或拉取失败时回退静态
- 静态内置模型全量入表：新增 `scripts/generate-model-catalog-seed.ts` 生成
  `supabase/seed/model_catalog_seed.sql`（78 条幂等 upsert），管理员执行一次后
  模型统一在 Supabase 表中管理配置
- 同步完全在后台自动进行，不向用户暴露任何同步入口；条目由管理员在
  Supabase 后台（Studio/SQL）维护
- 协议适配层保持代码化：远程条目仅覆盖目录级字段，不引入新调用协议；
  新协议模型仍需发版编写 adapter

## Impact

- Affected specs:
  - `remote-model-catalog`（新增）
- Affected code:
  - `supabase/migrations/model_catalog.sql`（新增）
  - `packages/drawnix/src/utils/remote-model-catalog.ts`（新增）
  - `packages/drawnix/src/constants/model-config.ts`（合并链扩展）
  - `packages/drawnix/src/utils/runtime-model-discovery.ts`（选择器接入远程层）
  - `packages/drawnix/src/runtime.ts`（导出配置/刷新接口）
  - `apps/web/src/supabase/supabase-client.ts`（导出 anon key 常量）
  - `apps/web/src/supabase/auth-context.tsx`（启动装配 + 后台定时/回前台刷新）
- 不影响：调用链路、计费、ai-proxy；未配置/拉取失败时产品行为与现状完全一致
