# Design: AI 模板中心 + 边缘函数爬虫

## Context

参考目标为建筑学长 AI 模板广场（见需求截图）：顶部「AI创作 / AI画布 / AI模板」三个
tab，模板页为分类 tab（AI绘画创作、AI设计智能体、AI模型渲染、AI总图彩平填色、
画布创作、AI手绘创作、局部重绘、意象概念创作、AI分析图生成工具、AI全景图创作、
平面转三维图）+ 瀑布流卡片（封面大图、标题、作者 @昵称、点赞数、提示词摘要），
支持 热度/最新 排序。点开模板可得完整提示词/工作流步骤，用户复用即可复现效果。

对目标站点的侦察结论（2026-09-15 实测）：

- 站点为客户端 SPA（`/canvas/home` 壳 HTML 仅 6.8KB，逻辑在 CDN bundle
  `web-assets.jianzhuxuezhang.com/jzxz/v2.17.14/`），列表数据全部走 XHR；
- 已确认的后端网关：`https://api.jianzhuxuezhang.com/jzxz`（主 API）、
  `https://community.jianzhuxuezhang.com/cykj_community`（社区）、
  `https://sso.jianzhuxuezhang.com/cykj_sso`（登录）、图片 CDN
  `https://image-assets.jianzhuxuezhang.com/`；
- 模板列表/详情的具体端点未在主 bundle 中出现（懒加载分包），需 Phase 0
  用浏览器 DevTools 抓包定位（见 Open Questions）。

关键平台约束（2026-09-15 实测确立）：自托管 edge-runtime 对 user worker 有
**CPU 时间软/硬限制（1s/2s）**，墙钟限制本次已放宽至 15 分钟。含义：爬虫
**必须走 JSON 接口**（fetch 等待不耗 CPU，JSON.parse 小响应 CPU 开销极低），
不能做 HTML/DOM 解析或大字符串正则提取（会撞 CPU 硬限导致请求被杀）。

## Goals / Non-Goals

- Goals:
  - 模板中心 UI 对齐截图形态：分类 tab + 瀑布流 + 热度/最新排序 + 搜索
  - 模板「可用」：一键复制提示词、填充 AI 创作输入框、工作流类模板一键导入
  - 内容管道以边缘函数实现（用户指定）：手动触发 + 幂等增量同步
  - 来源可追溯、可一键下线（合规开关）
- Non-Goals:
  - 不做 UGC 上传/审核（自运营模板后续迭代）
  - 不做点赞互动的社交体系（仅有使用计数）
  - 不做定时调度基础设施（pg_cron 可用性未确认，v1 手动触发）

## 架构总览

```
浏览器（模板中心 UI，直连 PostgREST 读 + RPC 用）
   │  ①读 active 模板（RLS: authenticated）
   ▼
PostgREST ── ai_templates / template_usage_log（新表）
   ▲  ③use_template RPC（原子 +1 使用计数）
   │
管理端/脚本（管理员工具）                    建筑学长站点（外部）
   │  ②POST /crawl（管理员 JWT）              │ JSON API（Phase 0 抓包定位）
   ▼                                         ▼
supabase-edge-functions: template-crawler ──┘
   │  列表同步 → 详情富化 → 封面转存 huabu → upsert
   ▼
ai_templates
```

## Decisions

### D1 爬虫形态：边缘函数 + JSON API（不用 HTML 解析）

- `supabase/functions/template-crawler/`，对齐现有函数结构
  （`index.ts` 注入 env、`core.ts` 纯逻辑可单测、`core.test.ts` node:test）
- 端点：`POST /crawl`（body `{categories?, maxPages?}`）触发同步；
  `GET /stats` 返回各分类模板数/最后同步时间
- 鉴权：Bearer 用户 JWT（`/auth/v1/user` 自证）+ 管理员白名单
  （复用 dashboard-stats 的 `department_configs.dashboard_admins` 机制），
  防止普通用户触发爬取
- **必须调用站点的 JSON 接口而非抓 HTML**：edge-runtime CPU 限制（1s/2s）使
  HTML 解析不可行；fetch 等待与 JSON 解析不受影响。若 Phase 0 发现关键数据
  仅存在于 HTML 中，则该部分降级为仓库内 Node 脚本离线导入（见 Risks）

### D2 同步策略：两阶段 + 幂等 upsert + 增量

1. **列表阶段**：按分类分页拉列表（页间 sleep ≥2s 控速，单次运行
   `maxPages` 封顶默认 20），取 `source_id/title/cover/author/likes/category`
2. **详情阶段**：仅对**新增或变更**（likes 变化/字段哈希变化）的条目拉详情，
   取完整 prompt / 工作流步骤 / 标签
3. 幂等：`UNIQUE(source, source_id)`，`ON CONFLICT DO UPDATE`；
   本地已存在且源未变更的条目不重复拉详情（增量）
4. 停止同步：`ai_templates.status='hidden'`（软下线），不物理删除

### D3 图片：封面转存 `huabu` bucket

- 路径 `templates/{source}/{source_id}-cover.{ext}`，upsert 覆盖
- 理由：内网加载稳定可控、不受源站防盗链/失效影响；同时保留
  `source_url` 字段用于署名与「查看原文」跳转
- 转存在爬虫内完成：fetch 图片二进制（等待不耗 CPU）→ storage upload

### D4 数据模型（迁移 `supabase/migrations/ai_templates.sql`）

```sql
create table if not exists ai_templates (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'jzxz',            -- 来源站标识（预留多来源）
  source_id text not null,                        -- 来源站模板 id
  category text not null,                         -- 分类（对齐截图 11 类）
  title text not null,
  prompt text,                                    -- 完整提示词
  workflow_json jsonb,                            -- 工作流类模板步骤（可空）
  cover_storage_path text,                        -- huabu bucket 内路径
  source_url text,                                -- 原文链接（署名/跳转）
  author_name text,
  tags jsonb default '[]',
  likes int default 0,
  usage_count int default 0,
  content_hash text,                              -- 增量对比用
  status text not null default 'active',          -- active | hidden
  crawled_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(source, source_id)
);

create table if not exists template_usage_log (
  id bigint generated always as identity primary key,
  template_id uuid references ai_templates(id),
  user_id uuid not null,
  used_at timestamptz default now()
);

-- RLS：authenticated 可读 active、可插使用记录；模板写仅 service_role
alter table ai_templates enable row level security;
create policy "read active templates" on ai_templates
  for select to authenticated using (status = 'active');
alter table template_usage_log enable row level security;
create policy "insert own usage" on template_usage_log
  for insert to authenticated with check (user_id = auth.uid());

-- 原子使用计数 + 记录（前端「使用」按钮调用）
create or replace function use_template(p_template_id uuid)
returns void language plpgsql security definer as $$
begin
  insert into template_usage_log(template_id, user_id)
    values (p_template_id, auth.uid());
  update ai_templates set usage_count = usage_count + 1
    where id = p_template_id;
end; $$;
```

### D5 前端：模板中心挂在 AI 创作面板

- 入口：`components/ai-input-bar/` 增加模板按钮（图标入口，类似建筑学长
  「AI模板」tab 的心智）
- 组件：`components/template-gallery/`
  - `TemplateGallery.tsx`：抽屉/弹层容器，分类 tab + 热度/最新切换 + 搜索框
  - `TemplateCard.tsx` / `TemplateMasonry`：瀑布流（CSS columns 实现，不引新依赖）
  - `TemplateDetail.tsx`：大图 + 完整提示词 + 复制 + 「去创作」+（工作流类）
    「导入工作流」（走现有 `workflow-converter` 导入链路）
- 数据读取：supabase-js 直查（RLS 已限制 active），分页 limit/offset；
  「使用」按钮调 `use_template` RPC 后，把 prompt 填入 AI 输入框
  （或触发工作流导入），并关闭模板面板
- 分类列表前端硬编码（对齐截图 11 类 + 「全部」），与爬虫 category 取值约定一致

### D6 触发与调度

- v1：手动触发——服务器上 `scripts/crawl-templates.mjs`（铸造管理员 JWT →
  调 `/crawl`）或看板管理入口按钮
- 后续（Open Question）：确认自托管栈 pg_cron 可用性后可加每日增量同步

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| **版权/合规**：爬取并转存第三方站点模板内容用于内部平台展示 | 仅限内部企业平台使用、保留来源署名与原文链接、`status='hidden'` 一键全量下线（按 source 过滤 update）、控制抓取频率；正式对外前需取得授权或替换为自运营/授权内容（Open Question ①） |
| 反爬升级（签名参数/登录墙/限频封禁） | 控速 + 低频增量；若接口需登录 token，配置于 configs 表（如 `JZXZ_COOKIE`），由爬虫注入；彻底失效时模板中心仍可运行（存量数据），爬虫报警即可 |
| 关键数据仅在 HTML 中（无 JSON 接口可用） | 该部分不在 edge function 内解析（CPU 限制），降级为仓库内 Node 脚本解析后经 `--import` 批量入库，边缘函数仅做增量补拉 |
| 爬虫撞 CPU 硬限（2s）导致 500 | 强制走 JSON、响应体按页分批处理、单页解析只取必要字段；core 单测覆盖大列表解析耗时路径 |
| 瀑布流长列表渲染性能 | PostgREST 分页（每页 30）+ CSS columns；不做虚拟滚动（卡片数 < 数百级） |

## Migration Plan

1. 执行 `ai_templates.sql`（新表 + RLS + RPC，均幂等可重跑）
2. 部署 `template-crawler`（volumes/functions 热加载）
3. Phase 0 抓包 → 配置接口路径常量 → 首次全量爬取 → 前端入口上线
4. 回滚：前端隐藏入口 + `update ai_templates set status='hidden' where source='jzxz'`
   + 删除 `volumes/functions/template-crawler`

## 附录：Phase 0 接口侦察结果（2026-09-15 实测破解并验证）

### 列表接口（游客可访问，已 curl 实测 200）

```
GET https://community.jianzhuxuezhang.com/cykj_community/templates
    ?product_id=51
    &version_code=21714
    &pageNum=0            # 分页，从 0 开始
    &pageSize=30
    &templateType=BANANA_CASE
    &productType=JZXZ
    &sign=<见下>
Headers:
    Product-Type: JZXZ
    lang: zh-CN
    timestamp: <见下>
```

响应（数组，无外层包装）：

```json
[{
  "title": "景观展板5", "templateId": "6a82c3e67403db128be31b67",
  "templateVersion": "GPT_IMAGE_2",
  "coverUrl": "https://ai-assets.jianzhuxuezhang.com/gpt_img/xxx.png",
  "width": 1536, "height": 2048,
  "useCount": 0, "viewCount": 208, "collectCount": 0,
  "createdDate": 1786954726799, "isCollection": false
}]
```

### 鉴权算法（从 v2.17.14 主 bundle 逆向，已本地复算与抓包位一致）

1. **sign 参数**（query 携带）：

```
串 = params 按键名 JS 默认排序 → "k=v" 用 & 连接（空值跳过，值 trim，不 URL 编码）
     + "&key=d9fd3ec394"
sign = MD5(串).toUpperCase()
```

2. **timestamp 头**（陷阱：13 位但不是毫秒）：

```
epochSec = floor((Date.now() + overscan) / 1000)
校验码   = String((epochSec ^ 334) % 1000).padStart(3, "0")
timestamp = String(epochSec) + 校验码          // 例如 "1789453285971"
```

服务端校验 sign 与 timestamp 校验位，任一不对返回
`400 {"errorCode":"API_ILLEGAL_REQUEST","message":"非法请求"}`。

### 详情接口（游客可访问，2026-09-15 二次抓包确认）

```
GET https://community.jianzhuxuezhang.com/cykj_community/templates/{templateId}
Headers: 同列表（Product-Type / lang / timestamp；URL 无 sign 参数）
```

响应含完整内容：

```json
{ "title": "...", "templateId": "...", "templateVersion": "GPT_IMAGE_2",
  "coverUrl": "...", "width": 613, "height": 407,
  "catalogs": [["效果渲染", "景观渲染"]],
  "content": { "prompt": "完整提示词文本", "aspectRatio": "auto",
               "resolution": "1k", "baseImageList": [],
               "generateImage": "效果图URL" } }
```

注意：`POST /templates/latest`（最近常用）需要登录（401 TOKEN_NOT_EXISTED），
爬虫主流程不使用。登录态仅后续「每日自动登录续 cookie」需求才涉及。

### 已知 templateType（2026-09-15 全量爬取后确认）

- **`BANANA_CASE` 是唯一列表类型**：抽屉内子分类（效果渲染/总平填色/…）为
  **客户端过滤**（基于详情/列表的 `catalogs` 字段），点击子分类不产生新请求。
- 单次调用受墙钟限制曾误判"900 条封顶"——实际深层分页有真实数据，
  `startPage` 逐页调用后全量 **1291 条**已入库（2026-09-15，其中 578 条
  携带原图/参考图 `base_images`）。

### 全量同步的工程约束（实测确立）

- edge-runtime 有 CPU 时间软/硬限制（1s/2s），单次调用处理页数过多会被杀
  （WorkerRequestCancelled）→ `template-crawler` 支持 `startPage` 分批调用，
  服务器脚本 `crawl-templates.sh` 逐页循环调用（每页一次调用）；
- 增量：列表哈希（`extra.list_hash`）与库中一致 → 免拉详情直接跳过，
  每日增量只需处理新增/变更条目；
- 服务器触发脚本：`/home/mdc/codes/supabase/crawl-templates.sh`（仓库副本
  `scripts/crawl-templates.sh`），每日 02:00 由 ZCode 定时任务经 SSH 调用。

### 待补（Phase 0.5，需登录态）

- 模板**详情/prompt** 接口：游客点击模板卡片无网络请求（弹登录），需站点账号
  登录后抓包（SSO：`sso.jianzhuxuezhang.com/cykj_sso`；bundle 内含 AES 加密
  逻辑，key=`ghff2lkh]wefjw4532423elkty@rhjv$`，iv=`qowzmzkcjfheywia`，CBC/PKCS7）。
- 其余 templateType 枚举与分类映射。


## Open Questions

（2026-09-15 已由需求方拍板）

1. ~~合规确认~~ → **已认可**：仅内部企业平台展示、保留署名与原文链接、控速抓取、可一键下线
2. ~~列表接口登录态~~ → 若接口需登录态，需求方提供站点账号密码，由脚本**每日自动登录
   换取 cookie/token** 存入 configs（`JZXZ_COOKIE`，含更新时间）；爬虫读取失效时告警
3. ~~周期同步~~ → **v1 手动触发**，后续再改定时执行
4. 封面图转存占用的 bucket 配额预估（首次全量约几百张 × 百 KB 级）
