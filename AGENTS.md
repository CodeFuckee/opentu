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