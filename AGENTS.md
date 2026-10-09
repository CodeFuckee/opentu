<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# 🚨 部署红线（对所有 AI 助手 / agent / 定时任务，永久生效，2026-09-15 由用户确立）

**生产环境部署（`deploy:production` 作业及任何面向生产环境的发布动作）永远且只能由用户本人手动触发。AI 助手禁止触发，没有例外。**

具体约束：

1. AI 在 main 流水线的职责**止于**：推送代码 → 监控到 build 与全部测试 job 成功 → 向用户汇报"生产部署待触发"。到此为止，然后等待用户。
2. 禁止以任何方式触发生产部署，包括但不限于：调用 GitLab API play/重试 deploy 作业、点击流水线按钮、脚本化触发、在定时任务中部署、以"修复生产缺陷/用户已在等待/上线收尾"等理由触发。
3. 以下情况**均不构成触发授权**：测试全绿、用户确认过前端效果或功能行为、用户确认过 E2E 结果、用户曾要求部署过类似变更、生产环境正出现该修复能解决的问题。
4. 若用户明确要求"部署生产"，AI 也应**请用户自行在 GitLab 上点击**，AI 只负责确认部署结果与后续验证。
5. 该约束同等适用于任何定时任务（如每日模板同步）：同步只做数据同步，永远不涉及部署。
6. 预览环境（deploy:preview 自动触发）不受此条约束；反馈环境（feedbackland:redeploy）同生产环境对待，仅由用户触发。

# 🌐 HTTP 部署约束（对所有 AI 助手 / agent，永久生效，2026-09-18 由用户确立）

**本项目通过 HTTP 明文部署并供内网（LAN IP）直接访问，任何功能的实现都必须确保在不安全连接（非 HTTPS、非 localhost）下可以正常运行。**

具体要求：

1. 浏览器只为 secure context（HTTPS / localhost）提供部分 Web 平台能力。新功能用到以下能力时**必须提供降级路径并实测 HTTP 访问可用**，否则在内网 HTTP 下静默失效：
   - `crypto.subtle`（Web Crypto）：项目先例见 `sha256Hex`（packages/drawnix/src/services/task-supabase-archive/core.ts）——无 subtle 时用确定性 FNV-1a 摘要兜底；
   - Clipboard / Notification / 摄像头麦克风 / Web Share 等 secure-context 专属 API：先探测可用性，不可用时降级为普通交互或明确提示，不允许裸调。
2. `navigator.serviceWorker` 在不安全 origin 上不可用（localhost 除外）：涉及 SW 的功能必须保证 SW 未注册时应用核心流程仍可用（降级执行器模式即为此设计，保持该前提）。
3. 不要依赖 HTTPS-only 的行为：如 `Secure`/`__Host-` 前缀 Cookie、自动升级的混合内容、HTTPS 专属 Referrer 语义等。
4. 功能验证时**不要只在 localhost 验证**：过目/测试应至少覆盖一次非 localhost 的 HTTP 访问（如 `http://10.37.80.175:7289` 这类 LAN 地址），localhost 的通过不能证明内网可用。

# 📄 纯文档提交的流水线策略（对所有 AI 助手 / agent，永久生效，2026-10-09 由用户确立）

**若本次推送的提交不含任何代码变化（仅 `*.md`、`docs/**` 等文档类文件；代码/配置/
CI/脚本/测试任一有变即不算），推送即交付：不触发、不监控流水线；GitLab 自动建的
流水线要取消，但取消前必须先确认是当前提交触发的，绝不误取消其他流水线。**

1. 不等待、不监控该次推送对应的流水线——文档推送完成即向用户报告交付。
2. GitLab 对 push 仍会自动创建流水线：应主动取消以省资源。**取消前必须核对**：
   流水线的 commit SHA 与本次推送的 HEAD 一致、且为该分支的 push 流水线；绝不
   误取消其他提交、其他分支或手动/web 触发的流水线。核对无误后取消：
   `GITLAB_HOST=home.chenkaidi.top:509 glab ci cancel <流水线id>`（或 GitLab API）。
3. 取消后流水线终态为 canceled，属预期结果，不按失败处理、无需排查。
4. 纯文档提交之上再追加代码提交时，恢复正常「推送 → 监控 → 全绿」流程；文档与
   代码同 commit 的，按代码提交对待（正常监控到终态）。
5. 此策略适用于本项目任何分支的文档类提交；与全局 `~/.zcode/AGENTS.md` §1 第 3 条
   同源。