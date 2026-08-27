# Tasks: 生图月度额度管控

## 1. 数据库

- [x] 1.1 新增迁移 `supabase/migrations/generation_usage.sql`：usage 表 + RLS + consume/refund/get 函数 + 异步任务记账表

## 2. 边缘函数 ai-proxy

- [x] 2.1 `core.ts` 纯逻辑：JWT 校验、配额 RPC 调用、apikey 注入转发、退回逻辑、quota 端点
- [x] 2.2 `index.ts` Deno 入口：CORS/OPTIONS、环境变量、路由分发
- [x] 2.3 `core.test.ts`：鉴权失败 / 扣减拒绝 / 上游失败退回 / 终态退回 / 透传不改写 用例（12/12 通过）

## 3. 前端 drawnix 包

- [x] 3.1 `services/managed-routing/managed-runtime.ts` 运行时注册器（含额度查询/超额错误识别）
- [x] 3.2 `provider-transport` 托管分支：登录托管态全量隧道至 ai-proxy，浏览器不再注入本地 key；
      服务端按路径白名单计量（未采用逐调用点打标记的方案，见 design.md 决策记录）
- [x] 3.3 凭据判定托管化（托管态所有路由视为就绪，不弹手填 Key 对话框）
- [x] 3.4 `useImageQuota` 钩子 + AI 图片/批量图片弹窗额度展示与超额提示

## 4. apps/web 壳层

- [x] 4.1 `auth-context` 增加 `getAccessToken()`（临期自动刷新）
- [x] 4.2 登录态变化时注入/注销托管路由配置

## 5. 文档与验证

- [x] 5.1 `docs/ai-proxy-edge-function.md`（部署步骤、configs 键、验收清单、回滚方式）
- [x] 5.2 边缘函数测试通过（node --test, 12 pass / 0 fail）
- [x] 5.3 前端验证：drawnix vitest 与基线无新增失败；web:typecheck 与 web:build 通过
