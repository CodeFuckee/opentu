# E2E 测试报告（Feedbackland 反馈入口跳转，2026-09-10）

- 运行环境：`pnpm e2e:feedbackland-entry`（nx run web-e2e:e2e --skip-nx-cache
  -- --project=feedbackland-entry --headed/--headless），Chromium（Playwright
  1.57）。主应用=本地 dev server（localhost:7200，当前代码），目标=预览实例
  http://10.37.80.25:8090/yjk。登录态复用 auth-setup 注册的 e2e 测试账号。
- 结果统计：总 4 条（FL-001~003 + auth-setup 依赖）| 通过 4 | 失败 0 | 跳过 0
  | 耗时 ~11s
- 覆盖评估：

  | 编号 | 用例 | 结果 | 关键断言 |
  |------|------|------|----------|
  | FL-001 | 点击反馈按钮，新标签页打开组织看板 | ✅ | 新标签页 URL = http://10.37.80.25:8090/yjk；看板标题/搜索框/排序/发帖区渲染 |
  | FL-002 | 目标看板页无错误态 | ✅ | 无 "Error loading posts"、无 "Internal Server Error" |
  | FL-003 | 点击后主应用画布不受影响 | ✅ | 原画布 URL 不变、反馈按钮仍在 |

  计划 3 条全部实现；范围外（按钮样式、其他侧边栏功能、站内发帖）未覆盖，
  与确认门 1 约定一致。

- 稳定性评估：连续 2 次完整运行结果一致（4 passed × 2），无 flaky。
  自测过程中修复 1 处脚本缺陷：新标签页创建（about:blank）与真实导航存在
  竞态，URL 断言改为 waitForURL 等待目标地址到达。

- 结论：跳转链路（画布按钮 → 新标签页 → 组织看板 /yjk）与目标页渲染均正确，
  套件就绪。

## 环境参数化（后续补充）

- 主应用侧环境可经 `MAIN_APP_BASE_URL` 切换（默认本地 dev 7200）：
  - 本地：`pnpm e2e:feedbackland-entry:headed`
  - 生产侧：`MAIN_APP_BASE_URL=http://10.37.80.25:8088 pnpm e2e:feedbackland-entry:headed`
    （Git Bash；生产 8088 上按钮仍为旧地址 8090 根路径，用例将以
    Expected/Received 形式暴露该未发布缺陷，随下次发布修复）
- 期望看板地址可经 `FEEDBACKLAND_EXPECTED_URL` 覆盖（默认
  http://10.37.80.25:8090/yjk）。

