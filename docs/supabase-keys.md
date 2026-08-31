# Supabase Key 配置与轮换指南

本文汇总本项目所有 Supabase key（ANON / SERVICE_ROLE）的存放位置与修改方式。

## 1. ANON key（公钥）

性质：仅用于浏览器端鉴权入口，**不视为机密**（真正的安全控制由服务端 RLS /
service_role 负责）。可以出现在前端 bundle 中。

### 仓库内的两处默认值

| 位置 | 说明 |
|------|------|
| `apps/web/src/supabase/supabase-client.ts`（`SUPABASE_ANON_KEY`） | 前端 Supabase 客户端。优先读构建环境变量 `VITE_SUPABASE_ANON_KEY`，未设置时回退到硬编码默认值 |
| `scripts/edge-function-smoke.mjs`（`DEFAULT_ANON_KEY`） | 边缘函数冒烟脚本。可用命令行参数或 `SUPABASE_ANON_KEY` 环境变量覆盖 |

### 推荐修改方式

1. 在 `apps/web/.env`（由 `apps/web/.env.example` 复制而来）设置：

   ```
   VITE_SUPABASE_URL=http://10.37.80.25:8021
   VITE_SUPABASE_ANON_KEY=<新的 anon key>
   ```

2. 同时更新 `apps/web/src/supabase/supabase-client.ts` 第 16 行与
   `scripts/edge-function-smoke.mjs` 第 25 行两处硬编码默认值，保持回退值一致。
3. 重新构建前端：`pnpm run build`（本地开发 `pnpm start` 自动读取 `.env`）。

## 2. SERVICE_ROLE key（私钥，机密）

性质：绕过 RLS 的后台密钥，**绝不进前端 bundle**。

**仓库内没有任何地方硬编码其值**。所有边缘函数（`ai-proxy`、`check-email`、
`check-register`、`newapi-key`、`sync-staff-profile`）均通过
`Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` 从**部署端环境变量**读取。

### 修改方式（部署端）

自托管 Supabase 实例，两种途径任选：

- **容器环境变量**：在 Supabase 部署目录（如 `/home/mdc/codes/supabase/`）的
  compose/config 中设置 `SUPABASE_SERVICE_ROLE_KEY=<新的 service_role key>`，
  修改后重启相关容器；
- **secrets**：`supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<新的 key>`。

轮换后需将密钥同时更新到所有读取它的位置（Supabase 管理端
Settings → API 中的 service_role key 与容器环境变量保持一致）。

## 3. 修改后的自检

```bash
# 1. 前端 anon key 生效
node scripts/edge-function-smoke.mjs http://10.37.80.25:8021

# 2. service_role 生效（应返回我们函数的 401 JSON，而不是凭证错误）
curl -i http://10.37.80.25:8021/functions/v1/ai-proxy/quota
```

## 相关文档

- `docs/check-email-registered-login-hint.md`（service_role 环境变量命名注意项）
- `docs/ai-proxy-edge-function.md`（ai-proxy 部署，容器内环境变量已就绪）
- `apps/web/.env.example`（前端 Vite 环境变量示例）