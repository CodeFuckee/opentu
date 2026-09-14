# Design: 云端模型目录

## Context

模型目录现状为「静态 TS 常量 + 用户级运行时发现」双轨制（见 `specs/runtime-model-discovery/spec.md`）。
新模型上架需要改 `model-config.ts`、`video-model-config.ts`、`video.types.ts` 等多个文件并发版。
平台已有自托管 Supabase，且模型目录数据不含机密（密钥全部由 ai-proxy/用户自持），
适合用一张匿名可读的表作为全局运营通道。

## Goals / Non-Goals

- Goals
  - 同协议新模型经数据库配置即可上架，分钟级生效，不发版
  - 远程条目可覆盖内置同 ID 条目的目录级元数据（名称、默认参数、排序分、VIP 标记）
  - Supabase 不可达/数据损坏时，产品行为回退到与现状完全一致（静态目录）
- Non-Goals
  - 不做管理后台 UI（直接用 Supabase Studio 改表）
  - 不支持"远程下架内置模型"（需要处理默认模型/用户偏好兜底，风险大，留作后续）
  - 不数据化协议适配层：新协议仍需发版编写 model-adapter
  - 不改动计费、调用链路与 ai-proxy

## Decisions

- **存储：PostgREST 表而非 Storage JSON**。行级结构便于 Supabase Studio 编辑、
  单行启停与增量排查；读取端一次 `select` 全量拉取（目录规模 < 1k 行，无需分页）。
- **读取鉴权：匿名（anon key）而非用户 JWT**。未登录 BYOK 用户也需要目录；
  目录数据本身公开，RLS `select` 对 anon 放开即可，登录态无关，逻辑更简单。
- **合并语义：表是唯一事实源（接管式）**。目录成功拉取且表内有生效条目时，
  静态内置目录整体退位——管理员在表内停用/删除/修改模型不会被静态定义"复活"；
  用户级运行时发现模型始终保留。目录为空或拉取失败时回退
  静态内置 + 运行时发现的既有行为，产品可用性不因后端故障改变。
  `getModelsByType`/`getModelConfig`/选择器/固定模型解析同步该语义。
- **静态目录全量入表**：`scripts/generate-model-catalog-seed.ts` 从静态常量
  生成 `supabase/seed/model_catalog_seed.sql`（78 条，幂等 upsert），
  由管理员在 Supabase 侧执行一次，之后模型上下架/改名/调参只维护表；
  仓库静态目录降级为"出厂兜底 + 新环境种子来源"。
- **校验：手写行校验器，不引入 zod**。字段有限（约 15 个），手写校验 + 非法行跳过
  即可，避免新增依赖；单条脏数据不影响其余条目。
- **缓存：localStorage 最近一次成功目录**。启动时先注水缓存再后台刷新，
  避免每次冷启动都白屏等待网络；缓存超过 7 天视为过期不再使用（防止长期
  复活已被运营删除的条目）。TTL 10 分钟内的重复刷新直接跳过（可 force）。
- **同步方式：纯后台自动，无用户入口**。目录维护是管理员职责（Supabase Studio/SQL
  直接改表），前端不向普通用户暴露任何同步操作；应用侧启动拉取一次，另有定时与
  「标签页回到前台」触发的 TTL 约束刷新（刷新函数内置 10 分钟 TTL，重复触发零成本），
  挂载与清理收敛在 AuthProvider 的单个 effect 中。
- **配置注入沿用 managed-routing 模式**：`packages/drawnix` 不直接读 Supabase 环境变量，
  由 `apps/web` 启动时经 `runtime.ts` 导出的 `configureRemoteModelCatalog` 注入
  `{ supabaseUrl, anonKey }`，与 `configureManagedRouting` 等既有装配方式一致。
- **装配点：AuthProvider 挂载 effect（与登录态无关）**。登录/未登录用户都需要目录。

## Risks / Trade-offs

- 脏数据直接进线上选择器 → 手写校验器逐行校验，非法行跳过并在控制台 warn；
  单测覆盖各类畸形行。
- 远程依赖增加（表不可达）→ 三级降级：缓存 → 静态目录；表结构与读取端
  均为可选依赖，不影响启动。
- 远程条目与静态条目 ID 冲突导致行为漂移 → 覆盖语义在 `model-config.ts` 单测中
  固化（remote 覆盖同 ID 的 runtime/static 条目）。
- 目录数据与网关实际模型不一致（表里配了网关没有的模型）→ 选择后调用报错由
  现有错误链路呈现；运营约定：条目 ID 必须与网关一致（表注释中写明）。

## Migration Plan

1. 在 Supabase 执行 `supabase/migrations/model_catalog.sql`（幂等，可重复执行）。
2. 发布前端后目录为空表状态，行为与现状一致；运营按需插入条目。
3. 回滚：停用条目（`enabled=false`）或整表清空即可，无需前端回滚。

## Open Questions

- 是否需要"远程下架内置模型"能力（涉及默认模型与用户偏好的兜底策略，本期不做）。
