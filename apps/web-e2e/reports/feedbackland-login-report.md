# E2E 测试报告（Feedbackland Supabase 账号登录，2026-09-10）

- 运行环境：`pnpm exec nx run web-e2e:e2e --skip-nx-cache -- --project=feedbackland`，
  Chromium（Playwright 1.57），headless，被测环境 http://10.37.80.25:8090
  （生产预览实例，后端=生产 Supabase）
- 测试账号：`chenkaidi@yjk.com`（apps/web-e2e/.env.e2e.local 的
  E2E_CUSTOM_ACCOUNT / E2E_CUSTOM_PASSWORD；未配置时用例自动跳过）
- 结果统计：总 6 条 | 通过 6 | 失败 0 | 跳过 0 | 耗时 ~5s
- 覆盖评估：

  | 编号 | 用例 | 结果 | 关键断言 |
  |------|------|------|----------|
  | FB-001 | Supabase 账号登录成功 | ✅ | 头部登录入口消失、头像按钮出现 |
  | FB-002 | 登录后用户名正确 | ✅ | 头像下拉菜单显示用户名 `chenkaidi` 与账号邮箱 |
  | FB-003 | 帖子看板页面正确 | ✅ | 搜索框 / 排序筛选 / Submit feedback 发帖区渲染，无服务端错误 |
  | FB-004 | 未登录访问看板 | ✅ | 只读看板正常渲染（HTTP < 500，含搜索框） |
  | FB-005 | 错误密码登录失败 | ✅ | 表单显示失败提示（text-destructive），不进入登录态 |
  | FB-006 | 刷新后登录态保持 | ✅ | 刷新后头像按钮仍在（session 持久化） |

  计划 6 条全部实现；范围外（注册、SSO、发帖写操作、管理后台）未覆盖，
  与确认门 1 的约定一致。

- 稳定性评估：连续 3 次完整运行结果一致（6 passed / 6 passed / 6 passed），
  单次耗时 5.0~5.3s，无 flaky。

## 测试过程中发现并已修复的产品缺陷（3 个，均已包含在本次提交）

1. **IP 直连部署组织识别错误**（`feedbackland/lib/utils.ts` getIsSubdirOrg）：
   原逻辑仅认 localhost/vercel.app 为路径式组织，IP:端口部署
   （10.37.80.25:8090）被误判为子域名模式，客户端把 IP 首段 "10" 当
   orgSubdomain 调接口 → 登录建档 500、帖子列表 "Error loading posts"、
   用户名显示 "Unnamed user"。修复：IP/无点主机按路径式组织处理。
2. **主应用账号无 displayName 元数据**（feedbackland/hooks/use-auth.tsx）：
   Yue画布 注册流程不写 user_metadata.displayName，Feedbackland 只读该键 →
   所有主应用账号登录后显示 "Unnamed user"。修复：displayName 缺失时回退
   到邮箱前缀（chenkaidi@yjk.com → chenkaidi）。
3. **镜像构建 npm ci 失败**（feedbackland/Dockerfile）：typescript@7 与
   typescript-eslint@8.66 peer 冲突，新版 node:22-alpine 的 npm ci 硬失败。
   修复：--legacy-peer-deps（eslint 仅开发工具链，运行期无影响）。

## 遗留事项（不阻塞本套件）

- DB 引导会幂等种子 org `yjk`（未认领状态）；如需将 chenkaidi 设为该组织
  管理员，在浏览器登录后访问 /yjk/claim 完成认领即可。
- storage 段（schema.sql 尾部）仅在主 Supabase 库适用，feedbackland 独立库
  应用时的报错已容忍；images 桶已通过 storage API 创建（public）。
