# Change: 生图月度额度管控（每人每月 200 张）

## Why

当前生图的 API Key 保存在用户浏览器 localStorage 中，请求由前端直连中转站（new-api）。
任何拿到 Key 的人都可以绕开页面无限制调用，无法实施"每用户每月最多生成 200 张图"的管控。
需要把鉴权与计量下沉到服务端，使额度成为硬约束。

## What Changes

- 新增 Supabase 边缘函数 `ai-proxy`：验证调用者 JWT → 原子扣减当月生图张数 → 用服务端保存的
  `user_profiles.apikey` 转发到自建 new-api；上游失败自动退回额度
- 新增数据库表 `generation_usage` 与配额函数（consume/refund/get），按自然月惰性计算，
  默认限额 200，可经 `department_configs` 按部门覆盖
- 前端 `provider-transport` 增加"托管路由"分支：登录用户走 ai-proxy，浏览器不再持有 API Key；
  多协议适配器逻辑不变
- 凭据判定对 image 操作托管化：不再向用户弹出手填 API Key 的对话框
- AI 图片 / 批量图片弹窗展示本月剩余额度，并在超额时给出友好提示

## Impact

- Affected specs:
  - 无现有 spec 覆盖此能力（新增 `image-generation-quota` capability）
- Affected code:
  - `supabase/migrations/generation_usage.sql`（新增）
  - `supabase/functions/ai-proxy/`（新增 index.ts + core.ts + core.test.ts）
  - `packages/drawnix/src/services/provider-routing/provider-transport.ts`
  - `packages/drawnix/src/services/provider-routing/types.ts`
  - `packages/drawnix/src/services/managed-routing/managed-runtime.ts`（新增）
  - `packages/drawnix/src/utils/settings-manager.ts`（凭据判定托管化）
  - `packages/drawnix/src/components/ttd-dialog/ai-image-generation.tsx`
  - `packages/drawnix/src/components/ttd-dialog/batch-image-generation.tsx`
  - `apps/web/src/supabase/auth-context.tsx`
  - `apps/web/src/app/app.tsx`
