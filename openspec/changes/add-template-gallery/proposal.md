# Change: 新增 AI 模板中心（对标建筑学长模板广场，边缘函数爬虫同步）

## Why

应用已有 AI 创作（`components/ai-input-bar/`）与工作流体系（`workflow-types/converter`），
但用户面对空白输入框缺「从哪开始」的引导。对标建筑学长 AI 模板广场（截图参考）：
瀑布流模板卡片（封面图 + 提示词 + 作者 + 点赞），分类浏览、热度/最新排序，点击即可
复用提示词/工作流复现效果——能显著降低上手门槛、展示平台能力上限。

模板内容初始来源采用**边缘函数部署爬虫**，从建筑学长网站公开页面同步（用户指定方式），
后续可逐步替换/补充为自运营模板。

## What Changes

- 新增边缘函数 `template-crawler`：从建筑学长同步模板（列表 + 详情两阶段），
  转存封面图到 `huabu` bucket，按 `source+source_id` 幂等 upsert；管理端点需 JWT 鉴权
- 新增数据库迁移：`ai_templates` 模板表 + `template_usage_log` 使用记录表 + RLS
  （authenticated 可读 active 模板、可写使用记录；写模板仅 service_role）
- 新增前端「模板中心」：AI 创作面板新增模板入口，分类 tab + 瀑布流卡片 +
  搜索/排序，模板详情（大图 + 提示词复制 + 「去创作」填充输入框 / 工作流模板
  「导入工作流」），使用计数经 RPC 原子自增
- **不改动**现有 AI 创作与工作流执行链路，模板仅作为输入引导层

## Impact

- Affected specs: 新增 `template-gallery` 能力
- Affected code:
  - 新增 `supabase/functions/template-crawler/`
  - 新增 `supabase/migrations/ai_templates.sql`
  - 新增 `packages/drawnix/src/components/template-gallery/`
  - `packages/drawnix/src/components/ai-input-bar/`（新增模板入口按钮）
- 依赖：建筑学长站点公开接口（Phase 0 抓包定位）；`huabu` bucket（已有）
