# 建筑学长贴图素材库爬虫（jzxz-material-crawler）

本机 selenium 浏览器爬取建筑学长贴图素材库（配景库 12 分类贴图/抠像素材），图片转存
Supabase 公开桶 `jzxz-materials`，元数据 upsert 到表 `jzxz_materials`。
真实页面自行完成接口签名，**无需逆向签名算法**（wallpaper.soutushenqi.com
网关的签名与 community 网关不同源且含时间因子，已放弃逆向改走 UI 驱动）。

> 代码执行流程逐阶段梳理与失败模式诊断（为什么"总是失败/爬取不全"）见
> [jzxz-material-crawler-flow.md](jzxz-material-crawler-flow.md)，
> 配套流程图 [jzxz-material-crawler-flow.drawio](jzxz-material-crawler-flow.drawio)。

> **⚠ 2026-11 站点二次改版，入口与面板全部重写**：编辑器改为 AI 对话优先形态，
> 「上传探针图 → 贴图推荐面板」链路整条消失（全站 `input[type=file]` 移除、
> 粘贴进 AI 创作输入条、`wallpaper/reference` 不再由粘贴触发）。素材库迁入
> 左侧工具栏「素材库」弹窗（`ProductMaterialPopover`），内含家居库/植物库/
> 材质库/配景库四个 tab：前三个是新 3D 模型库（`commodity_materials` 接口，
> ref/modelUrl 字段，与本表贴图模式不同，暂不爬取）；**配景库沿用
> wallpaper/reference 接口**，12 个分类与子分类（素材分类）以 swiper 行呈现，
> 网格为 ReactVirtualized 虚拟滚动。分类 chip 必须真实鼠标点击（JS `.click()`
> 无效）；翻页靠**重复点击同一 chip**（面板预取 pageNum=0/1[/2]，无「下一页」
> 按钮，点击被吞重试一次，翻尽后响应为空即到库尾）。推广弹窗关闭控件变为
> ant-modal 内 `close_icon/close_btn`。**覆盖边界**：新 UI 每个 tag 只暴露
> 预取的 ~60 条，更深的页无 UI 入口（签名含参数+时间因子无法构造），每日
> 增量依赖新增素材出现在 tag 前部页面；若上游改为尾部追加将静默漏采，
> 届时需回头逆向签名或与上游要接口。

## 架构（2026-11-04 重写后）

```
Chrome（专用 profile，会话持久化；headless 由配置决定——修复了无头开关失效 bug）
  → enter_editor：/canvas/detail 编辑器（记忆 URL，失效走 /home）
  → close_overlays：关 ant-modal 推广弹窗（close_icon/close_btn）
  → open_scenery_panel：点「素材库」→ 弹窗切「配景库」tab → 点 ⧉ 展开视图
  → 页面注入 fetch/XHR 钩子（捕获 wallpaper/reference 响应）
  → 遍历 分类行(配景分类, 12 类，swiper 行扫描 + 真实点击) 
  → 每分类重开面板 → 枚举 素材分类 子 tag 行 → 逐 tag 真实点击收割预取页
  → 双通道收割：
     ① 网络捕获（点击发 wallpaper/reference 请求，pageNum=0/1 起步）
     ② DOM 网格收割（ReactVirtualized__Masonry 容器内 img，兜底缓存命中有响应缺失）
  → 图片按 {分类}/{md5}.{ext} 内容寻址上传桶（upsert 幂等）
  → 元数据按 (source_id, category) upsert 表（翻页乱序无影响）
```

- 请求 tag 与面板 chip 文本不严格相等（chip「青年」的请求是「免抠-青年人」、
  「绿树」的是「免抠-绿树.」）：归属判定用双向包含（tag_matches）。
- 点击被吞/缓存命中不发请求：连续 2 轮无响应且无新网格才判到库尾，中途自动
  重点；连续 3 轮有响应但零新增熔断防空转。
- 分类切换强校验：点击后素材分类行须变化或出现该分类已知 tag
  （CATE_TAGS 种子随爬取累积），未生效重试 ≤6 次。
- 展开视图（⧉）分类/子分类行全量可见，无需箭头滚动；行内箭头逻辑保留兜底。
- 已知素材无名称字段（响应仅 largeUrl/thumbUrl/width/height），
  source_id 取 URL 内 UUID 文件名。

## 首次部署

1. 执行迁移：`cat supabase/migrations/jzxz_materials.sql | ssh mdc@10.37.80.25 "docker exec -i supabase-db psql -U supabase_admin -d postgres"`
2. 复制 `scripts/jzxz-crawler.local.json.example` → `scripts/jzxz-crawler.local.json`，
   填入 `service_key`（service_role，gitignored 不会入库）
3. 首次验证：`python scripts/jzxz-material-crawler.py --dry-run --headed --max-pages 2`
4. 全量首爬：`python scripts/jzxz-material-crawler.py`（无头，时长视总量，可能小时级）
5. 定时：ZCode 定时任务每日执行（同模板同步模式）

## 命令

| 命令 | 作用 |
| --- | --- |
| `--dry-run` | 只抓取解析，落 `data/jzxz-captured/captured-*.json`，不上传 |
| `--headed` | 有头浏览器（调试观察） |
| `--login` | 首次登录模式（有头，扫码后自动保存会话到 profile） |
| `--max-pages N` | 每 tag 最大页数（覆盖配置，默认 200） |
| `--categories a,b` | 只爬指定分类 |

## 已知边界

- 上游若把新素材追加到 tag 列表尾部，每日全量翻页可覆盖；配置
  `stop_known_pages>0` 可提前收尾提速，但可能漏尾部新增（默认 0=全量翻页）。
- tag 词表随面板 DOM 而来，上游新增分类/tag 自动跟随，无需改码。
- 素材响应无名称字段，`name` 为空（如需名称需另外的接口）。
- 登录态：实测游客可浏览素材面板（登录弹窗直接关闭即可）；若上游改为
  必须登录，用 `--login` 扫码一次即可（profile 会话长期有效）。
