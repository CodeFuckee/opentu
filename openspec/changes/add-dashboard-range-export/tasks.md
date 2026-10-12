# Tasks: add-dashboard-range-export

## 1. 测试先行（core.test.ts，先确认失败）

- [x] 1.1 `parseOverviewRange`：合法区间 / 缺一 / 格式非法 / 非真实日期(2026-02-30) / start>end / start==end
- [x] 1.2 `buildXlsx`：ZIP 结构（PK 头/EOCD/条目可解析）、workbook.xml sheet 顺序、单元格值与类型（数字/内联字符串/null 省略）、XML 转义、sheet 名 31 字符上限与非法字符清洗、空行空表
- [x] 1.3 `buildOverviewWorkbook`：12 类 sheet 齐全与顺序、行数/首行值对齐 fixture、部门汇总金额(CNY=USD×汇率)与占比同页面口径、null 数值降级展示、按钮统计 sheet 有/无 buttonUsage 两种形态
- [x] 1.4 `buildDashboardHtml` 增量断言：自定义区间选项/日期输入/应用按钮、导出Excel按钮与 export 请求、保持既有断言全绿

## 2. 后端实现（core.ts / index.ts）

- [x] 2.1 core.ts：CRC32 + stored ZIP + SpreadsheetML 最小写入器 `buildXlsx`
- [x] 2.2 core.ts：`buildOverviewWorkbook`（12 sheet 组装，与页面渲染同口径）
- [x] 2.3 core.ts：`parseOverviewRange` 纯校验函数（注：V8 Date.parse 对 2026-02-30 宽容滚动，用显式年月日回验）
- [x] 2.4 core.ts 页面：自定义区间选项 + 起止日期输入 + 应用按钮 + 导出Excel按钮（blob 下载、401 刷新重试、LAST_EXPORT_QS 复用当前区间）
- [x] 2.5 index.ts：/export 路由（管理员门禁→aggregateOverview(±aggregateButtonUsage)→xlsx 响应，Content-Disposition 含 ASCII 与 UTF-8 双文件名）；overview 路由 start/end 非法返回 400

## 3. 验证

- [x] 3.1 新增单测先失败→实现→全绿；`node --test supabase/functions/*/core.test.ts` 全量通过（223 例）
- [x] 3.2 preview 脚本补 /export、/button-usage mock，本地启动供用户过目（自定义区间查询 + 导出 Excel 实际下载打开）

## 4. 收尾

- [x] 4.1 docs/dashboard-stats.md 增补（自定义区间用法、/export 接口、sheet 清单）；CHANGELOG Unreleased 条目
- [x] 4.2 提交推送 main，监控流水线 test 阶段全绿（用户已过目确认）
