# Change: Supabase 后端数据看板（dashboard-stats 边缘函数）

## Why

AI 生成能力上线后，任务归档（`task_submissions`）、用量计量（`generation_usage`）、用户
与部门（`user_profiles`/`staff_directory`/`departments`）、文件转存（huabu bucket）等数据
都已沉淀在 Supabase，但没有一个入口可视化这些数据。需要一个**托管在 Supabase 后端**的
管理看板，供管理员查看全量任务/用量/用户/存储统计，与用户使用的前端完全分离。

## What Changes

- 新增边缘函数 `supabase/functions/dashboard-stats/`（自托管 Supabase，scp 热加载部署）：
  - `GET /functions/v1/dashboard-stats/` → 自包含 HTML 看板页面（内联 CSS/JS/SVG 图表，
    无外部依赖，不依赖用户前端工具链），页面 JS 调下方接口渲染
  - `GET /functions/v1/dashboard-stats/overview?days=N` → 四类聚合统计 JSON
  - `OPTIONS` → CORS 204；其余方法/路径 → 404/405
- 聚合数据（函数内用 service_role 直查，绕过 RLS；沿用 newapi-key 的 PostgREST REST 模式）：
  - 任务统计：`task_submissions`（轻量列 + 日期过滤）→ 总量/按 type/status 分布/成功率/日趋势/平均耗时
  - 用量与额度：`generation_usage` → 按周期汇总、本月用量 Top 用户（join user_profiles）；
    限额读 `department_configs.image_monthly_quota_default`，缺省 200
  - 用户与组织：`user_profiles`/`staff_directory`/`departments` → 用户总数、部门/区域分布、最近注册、可用部门
  - 文件与存储：`file_paths`/`response_file_paths` jsonb 长度求和 + huabu bucket 对象数/总大小
    （service_role 调 storage 对象列表分页统计；失败降级只显示文件计数）
- 鉴权：**暂不做**（函数不校验调用者；HTML 内嵌 anon key 供 Kong 放行）。文档记录升级路径：
  后续在函数内加管理员判定（`department_configs` 配名单或按岗位）或 Kong 限制
- 文档 `docs/dashboard-stats.md`：部署（scp + 冒烟）与访问说明

## Impact

- Affected specs:
  - 无现有 spec 覆盖此能力（新增 `dashboard-stats` capability）
- Affected code:
  - `supabase/functions/dashboard-stats/`（新增：index.ts / core.ts / core.test.ts）
  - `docs/dashboard-stats.md`（新增）
  - `CHANGELOG.md`（Unreleased → Added）
- 无需新增数据库迁移、不动 apps/web 与用户前端、不引入外部依赖
