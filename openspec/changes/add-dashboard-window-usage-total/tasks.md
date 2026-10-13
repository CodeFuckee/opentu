# Tasks: add-dashboard-window-usage-total

## 1. 测试先行

- [ ] 1.1 `usageTotalForWindow`：区间覆盖月求和 / 日粒度 period（YYYY-MM-DD）按前 7 位计入 / 无重叠→0 / 空数据→0 / unknown 周期排除
- [ ] 1.2 `applyUsageMultiplier`：windowTotalUsed 随倍数缩放、windowMonths 不变
- [ ] 1.3 `aggregateOverview` 集成：usage.windowTotalUsed/windowMonths 装配（窗口月与 usage 行重叠）
- [ ] 1.4 `buildDashboardHtml`：「区间总用量」卡与 days>30 门控标记

## 2. 实现

- [ ] 2.1 core.ts：windowMonths（东八区，range 优先、否则按 days 回溯）+ usageTotalForWindow 纯函数
- [ ] 2.2 core.ts：usage 接口扩两字段；aggregateOverview 装配；applyUsageMultiplier 缩放
- [ ] 2.3 core.ts 页面：kpiCards 在 o.days>30 时追加「区间总用量」卡
- [ ] 2.4 preview fixture 补字段

## 3. 验证与收尾

- [ ] 3.1 新测试先失败→全绿；全量 node --test 通过
- [ ] 3.2 preview 过目（自定义 55 天区间出卡）→ 推送 main 监控 CI → docs/CHANGELOG
