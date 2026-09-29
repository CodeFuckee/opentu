# 建筑学长素材爬虫 · 代码执行流程梳理（诊断版）

> 对应代码：`scripts/jzxz-material-crawler.py`（890 行，行号以当前工作区为准）
> 流程图：`docs/jzxz-material-crawler-flow.drawio`（drawio 打开）
> 背景：爬虫"总是失败、或者爬取不全"，本文按真实代码执行顺序逐阶段梳理，
> 并标注每一处可能失败/中断/静默跳过的点。

## TL;DR：三个最重要的诊断结论

> **⚠ 2026-09-29 站点改版，入口链重写**：`/home` 已从编辑器变成"工作台"
> （项目列表/AI 工具导航，无本地上传链），编辑器迁移到
> `/canvas/detail?projectId=<id>`（从工作台「新建项目」进入，URL 记忆于
> `data/jzxz-canvas-project.json`，失效自动重建）；且编辑器内有 4 个
> `input[type=file]`（两个 `accept=.txt` 属其他功能），探针必须发进
> **accept 含 png/image** 的输入。9-28/9-29 两晚定时任务失败（entry-fail.png）
> 即此改版所致，已修复。下文入口相关行号为改版前快照，机制描述仍适用。

1. **P0 · 无头开关失效（根因级 bug）**：`jzxz-material-crawler.py:642` 无条件
   `opts.add_argument("--headless=new")`，而 `:633` 算出的 `headless` 变量**只用于打日志**。
   即 `--headed` 参数和配置 `headless:false` **从不生效，所有运行实际都是无头**。
   而此前已实测：无头模式下面板 ActionChains 点击系统性失效（无头 0/5 vs 有头 5/5）。
   → 这一条同时解释"分类点击未生效大面积跳过（爬取不全）"和"CfT 有头验证入口也失败"
   （那次'有头'验证其实仍在无头下运行）。
2. **两处死代码删掉了防护**：`click_chip_verified`（:512）与 `open_panel`（:583）
   **定义了但全文件无调用点**。tag 点击因此没有 active 生效校验；"每次分类切换前重开面板"
   的机制也不在主流程里（crawl 内联了一份入口序列，不含重开逻辑）。
3. **大量软跳过静默降低覆盖率**：入口之后的每一层（库 tab → 分类 → tag → 翻页）失败
   都只是 `[warn]` + `continue`/`break`，不重试升级、不中断、汇总里也看不出跳了哪些。
   "7 个分类零覆盖"就是逐层软跳过叠加的结果。

---

## 1. 运行模式与配置

| 模式 | 触发 | 行为 |
| --- | --- | --- |
| 上传模式 | `--upload-json <file>` | 纯 HTTP，不开浏览器：读 dry-run 捕获 JSON 逐条上传（:887-888） |
| 登录模式 | `--login` | 有头浏览器人工扫码，会话存 profile（:624-626 → :531-547） |
| dry-run | `--dry-run` | 只抓取解析，落 `data/jzxz-captured/`，不查库不上传 |
| 默认 | 无参数 | 增量爬取 + 下载 + 上传桶 + upsert 表 |

配置文件 `scripts/jzxz-crawler.local.json`（gitignored）。当前本机值：
`headless:false`、`max_pages_per_tag:60`、`page_delay_ms:1500`、
`chrome_binary: data/chrome-for-testing/.../chrome.exe`（CfT 153.0.8010.52）、
`chromedriver_path` 配对驱动、`chrome_profile_dir: data/jzxz-chrome-profile`。
**注意：`headless:false` 当前不生效（见 TL;DR 第 1 条）。**

## 2. 流程总览

```
main() 解析参数
 ├─ --upload-json → 纯 HTTP 上传 → 结束
 └─ crawl()
     ├─ --login → 人工扫码 → 结束
     ├─ load_config → 启动 Chrome（CfT + 专用 profile；⚠永远附加 --headless=new）
     ├─ 看门狗：进度静默 >30min → 转储线程栈 → os._exit(1)          (:164-174)
     ├─ 入口序列（2026-09-29 改版后）：enter_editor 进 /canvas/detail 编辑器
     │    （复用记忆 URL，失效→工作台点「新建项目」重建并记忆）
     │    → 关弹窗 → 注入 CAPTURE_HOOK
     │    → 等 upload_btn_box(25s)【硬失败①】→ 点击
     │    → 等图片 accept 的 input[type=file](20s)【硬失败②】→ send_keys 探针图
     │    → 等 first_cate_list(40s)【硬失败③】→ 面板就绪 → 重新注入钩子
     └─ for gallery in [家居库, 植物库, 配景库]:
          点击 tab_btn ≤4 次校验 active【失败→跳过整库】
          ├─ 家居/植物库：wait_any ∥ HARVEST_GRID → 合并 → process_batch
          │    → 连续3轮零新增熔断 / 无"下一页" → 该库结束
          └─ 配景库（两阶段）：
               阶段1 枚举：first_cate_list 箭头滚动全量收集分类
                 → 逐分类点击+校验 sub_cate 行变化（≤6次）【失败→跳过该分类】
                 → 枚举该分类 sub_cate_list 全部 tag
               阶段2 爬取：逐 tag：chip_element 滚动定位（≤60轮）【失败→跳过tag】
                 → 点击 → wait_any(8s) 按tag过滤 ∥ HARVEST_GRID → 合并
                 →【空→跳过tag】→ 翻页循环 process_batch
                 → 无"下一页"或翻页无响应 → 该 tag 结束
     汇总 log →（dry-run 落 captured-<ts>.json）→ driver.quit()
```

## 3. 分阶段详解

### 3.1 启动与浏览器（:623-657)

- `load_config()`（:191-198）：非 dry-run 必须有 `supabase_url`/`service_key`，缺则退出。
- Chrome 选项（:635-648）：`chrome_binary` → `opts.binary_location`（CfT 支持，未提交改动）；
  `--user-data-dir` 指向专用 profile；**`:642` 无条件加 `--headless=new`**（P0 bug）；
  另有 no-sandbox/disable-gpu/禁 AutomationControlled/1600×1000 窗口。
- 超时（:650-654）：脚本执行 45s、页面加载 60s——所有 `execute_script` 受此保护，
  这是"单次 JS 批量扫描"替代逐元素 `.text`（会卡死）的原因。
- 看门狗（:164-174，:655 启动）：每 60s 检查，进度静默超 1800s →
  `faulthandler.dump_traceback()` 转储全部线程栈 → `os._exit(1)`。日志见 `[watchdog]`。

### 3.2 入口序列：从首页到贴图面板（:660-706；2026-09-29 改版重写，见 TL;DR 更新框）

| 步骤 | 实现 | 失败行为 |
| --- | --- | --- |
| 进编辑器 | `enter_editor`：先试记忆的 `/canvas/detail?projectId=…`（25s 内见 upload_btn_box 即有效）；失效则工作台点「新建项目」（15 次重试找按钮），新 URL 落盘 `data/jzxz-canvas-project.json`。登录态失效（工作台出现登录按钮）时给出明确报错 | **硬失败⓪** `sys.exit`（现场存 entry-fail.png） |
| 打开编辑器页 | `driver.get` + sleep 6 | 页面加载超时由 page_load_timeout 兜底 |
| 关推广弹窗 | JS 点 `button[class*='close']` | 静默容错 |
| 注入捕获钩子 | `CAPTURE_HOOK`：猴子补丁 fetch/XHR，凡 `wallpaper/reference` 响应推入 `window.__jzxzCapture`（:73-103） | 页面刷新后钩子丢失，所以面板就绪后要**再注一次**（:705） |
| 找本地上传格 | 轮询 25s 可见 `upload_btn_box`，期间反复点关闭弹窗 | **硬失败①** `sys.exit("未找到本地上传入口")`（:675） |
| 点上传格 | `real_click` = ActionChains 移动→pause→click（:206-207） | 无头下此类点击系统性失效 |
| 等文件选择框 | 轮询 20s `input[type='file']`，**按 `accept` 过滤取 png/image 输入**（改版后编辑器混入 2 个 `accept=.txt` 输入，取 `inputs[0]` 会发错框） | **硬失败②**：先截图 `data/jzxz-captured/entry-fail.png` 再 `sys.exit`（:688-693）——9-28/9-29 定时任务即败在此处 |
| 塞探针图 | `send_keys(探针 png 绝对路径)`（1×1 像素，:152-153） | 无对话框则上一步已退出 |
| 等面板就绪 | 轮询 40s `first_cate_list` 出现 | **硬失败③** `sys.exit("贴图面板未出现")`（:703） |
| 收尾 | sleep 2 + 重注入 CAPTURE_HOOK | — |

三处硬失败都是 `sys.exit`：**整个 run 立即终止，当次尚未爬到的库/分类全部不做**
（已上传条目因逐条落库不丢失；dry-run 因 `flush_dry` 增量落盘也不丢，:310-316）。

### 3.3 Gallery 分发（:708-727）

- 找可见 `tab_btn` span（精确文本=库名）；不可见 → `[warn] 跳过`（软跳过，整库损失）。
- 点击后校验 `active` class 是否迁移，**≤4 次重试**；仍失败 → `[warn] 跳过`（整库损失）。
- 成功后 `drain()` 清空捕获缓冲，防止上一状态数据串账。

### 3.4 分支 A：家居库/植物库（无分类行，属性筛选直翻页，:729-763）

每轮：
1. `wait_any(timeout=10)`（:343-354）：每 0.5s 取走捕获队列并解析
   （`largeUrl||thumbUrl` → `source_id`=URL 文件名 stem）。**面板命中缓存不发请求时返回空**。
2. `HARVEST_GRID`（:105-130）：文档级扫描全部 `img` src/data-src 与 `background-image`，
   域名过滤 `image(-assets)?.soutushenqi.com`，按 stem 去重——缓存兜底通道。
   **网格区域锚定**（2026-09-29 更新）：有分类行时以 `first_cate_list` 行为锚
   （配景库）；**平铺库视图无分类行，退锚「家居库|植物库|配景库」tab 行并集，
   右界借「下一页」按钮补齐**——改版前若平铺视图命中缓存（不发请求），
   原锚直接空手而归报"无数据"。
3. 按 `source_id` 合并双通道（:738-741）。空 → "无数据，到库尾" break。
4. `process_batch`（见 3.6）。统计 `flat_stall`：**连续 3 轮零新增 → 熔断**（:747-751）。
5. 找可见"下一页"（div/span/button 文本匹配，:754-757）；没有 → "无下一页，到库尾"；
   有则点击 → sleep `delay`(1.5s) → 下一轮。

注意：此分支 DOM 通道收割的条目 `category/tag` 记为 None（属性筛选库没有分类概念）。

### 3.5 分支 B：配景库（两阶段，:765-866）

**阶段 1 · 枚举映射（:767-810）**

1. `enumerate_row_texts("first_cate_list", rounds=40)`（:389-425）：
   先 prev 箭头滚回行首（≤40 次），再循环「scan_chips 单次 JS 批量收集 → 无新增或无 next
   箭头即止 → 点 next → sleep 0.6」。swiper 虚拟渲染下滚出视口的 slide 会被移除，
   所以必须"滚一批、收一批"。文本长度 >12 的丢弃。
2. 若指定 `--categories` 则与枚举结果求交。
3. 逐分类点击（:773-809）：
   - 快速通道：当前 sub_cate 行已有 CATE_TAGS 已知 tag → 视为已选中，不点。
   - 否则 ≤6 次尝试：找 first_cate_list 里精确文本的 slide → `real_click` →
     15s 内轮询 sub_cate 行文本是否出现已知 tag 或发生变化。
   - **失败 → `[warn] 分类点击未生效，跳过`（:809）——历史重灾区，7 个分类零覆盖
     直接源于这里**（无头下 ActionChains 点击失效 + 长会话面板状态漂移）。
   - 成功 → 枚举该分类 sub_cate_list 全部 tag 存入 `cat_tags`，并回写累积 `CATE_TAGS`。

**阶段 2 · 逐 tag 爬取（:812-866）**

1. `chip_element("sub_cate_list", tag)`（:428-509）：文档级 XPath 定位（不受 swiper 重渲染
   影响），≤60 轮：目标在可视窗 → 返回；存在但滚出视口 → 按中心 x 相对行中点判断方向，
   点 y 坐标同行配对的 prev_/next_ 箭头把它滚回来。**60 轮失败 → `[warn] chip 不可见，跳过`**。
2. `real_click(tag_el)` → sleep 3 → `wait_any(8s)` → 按 `norm_tag(响应tag)==tag` 过滤。
3. `HARVEST_GRID` 收割 → `merge_into_result`（:550-559）：网络批与 DOM 批按 source_id
   合并；无网络批时整体用 DOM 批（tag 归账为当前 tag）。
4. 空 → `[warn] 无响应且无网格，跳过`（:831-833）。
5. 翻页循环（≤max_pages=60）：`process_batch` → （`stop_known_pages>0` 时连续 N 页全已知
   可提前收尾，本机配置 0=关闭）→ 找"下一页"：无 → "到库尾"；点击后 `wait_any(8s)` 无响应
   → "翻页无响应，到库尾"。

### 3.6 共用落库：process_batch / upload_item（:319-340，:268-307）

`process_batch`：
1. `known_source_ids`（:249-257）：把本批 source_id 拼成 `in.(...)` 一次 REST 查询，
   命中即 `skipped_known`（增量幂等的关键）。
2. dry-run → 追加 `all_items` 并 `flush_dry` 覆盖写 `captured-dryrun.json`（随时可取）。
3. 正常 → `upload_item`，每条间隔 0.2s。

`upload_item`（全防御式，任何失败只返回状态串，不抛异常）：
1. 下载：两套 headers（带 Referer → 不带）各试一次，超时 90s。
   失败 → `download_failed`（第三方 CDN 如 seopic.699pic.com 403/405 都归这里）。
2. 上传桶：`PUT /storage/v1/object/jzxz-materials/{分类slug}/{md5}.png`，
   `x-upsert:true`，内容寻址幂等。非 2xx → `upload_http_{code}`
   （storage key 仅 ASCII，故有 `CATE_SLUGS` 中文→slug 映射，未知分类回退 `c+md5`，:260-265）。
3. upsert 表：`POST /rest/v1/jzxz_materials?on_conflict=source_id`，
   `resolution=merge-duplicates`。非 2xx → `table_http_{code}`。
4. 行字段：`source_id/gallery/category/tag/name/width/height/preview_path/file_path/
   source_url/content_hash`——**保留源 URL 便于调试**。

### 3.7 收尾（:868-875）

汇总 log（pages/items/downloaded/skipped_known/failed）；dry-run 另落
`captured-<时间戳>.json`；`finally: driver.quit()`。

## 4. 失败模式清单

### 4.1 硬失败（sys.exit / os._exit —— 整个 run 终止）

| # | 位置 | 触发条件 | 已观测？ |
| --- | --- | --- | --- |
| H1 | :675 | upload_btn_box 25s 未出现 | — |
| H2 | :693 | input[type=file] 20s 未出现（先截图 entry-fail.png） | **是：CfT 当前卡点** |
| H3 | :703 | first_cate_list 40s 未出现（探针图后面板没起来） | — |
| H4 | :164-174 | 看门狗：进度静默 >30min（曾用 60s 静默版本命中过） | 是（历史） |
| H5 | :191-198 | 配置缺失 | — |

### 4.2 软跳过（[warn] 后继续 —— 静默降低覆盖率，run 不失败）

| # | 位置 | 触发条件 | 覆盖损失 |
| --- | --- | --- | --- |
| S1 | :711-713 | 库 tab 不可见 | 整库 |
| S2 | :723-725 | tab 点击 active 未迁移（≤4 重试后） | 整库 |
| S3 | :809 | **分类点击未生效**（≤6 重试后） | **整分类（历史 7 分类零覆盖）** |
| S4 | :821-822 | chip 60 轮滚动定位失败 | 整 tag |
| S5 | :831-833 | wait_any(8s) 无响应且网格无图 | 该 tag 首页起全跳 |
| S6 | :853-855 | 找不到"下一页"按钮 | 该 tag 剩余页 |
| S7 | :864-866 | 翻页后 8s 无响应 | 该 tag 剩余页 |
| S8 | :747-751 | 家居/植物连续 3 轮零新增熔断 | 可能提前收尾（新增判定依赖查库，一般可靠） |
| S9 | upload_item | download_failed / upload_http_* / table_http_* | 单条（计 failed，下次 run 会重试——因为没入库，查重不过） |

### 4.3 数据正确性风险（不报错，但数据可能"错"）

| # | 位置 | 风险 |
| --- | --- | --- |
| R1 | :819-830 | tag 点击**无生效校验**（`click_chip_verified` 是死代码）——点击失败时仍会收割当前网格，把**上一个 tag 的图误归到当前 tag**（DOM 通道归账用循环变量） |
| R2 | :738-741 | 家居/植物库 DOM 通道条目 category/tag 记 None |
| R3 | :288 | 桶对象一律按 `.png` + `Content-Type: image/png` 上传，不辨别真实格式 |

## 5. 现象 → 根因映射

| 用户观测的现象 | 代码解释 |
| --- | --- |
| "总是失败"（入口报错退出） | H1/H2/H3 三处 sys.exit；CfT 验证卡 H2 |
| "CfT 有头模式入口也失败" | **`:642` 无条件 `--headless=new`，所谓有头实际仍是无头** |
| "人物配景等 7 分类零覆盖 / bucket 里只有植物" | S3 分类点击未生效（无头 ActionChains 失效）；一旦某分类被跳过，当次 run 内没有任何升级重试或重开面板 |
| "长会话跑着跑着大量点击未生效" | 面板状态漂移；`open_panel`（每次切换前重开面板）是死代码未接入主流程 |
| "有些 tag 明明有图却没爬到" | S5（8s 等待偏短/缓存无请求且网格为空）、S4（chip 定位失败）、S6/S7（翻页提前收尾） |
| 偶发条目 failed | S9：第三方 CDN 403/405、下载超时 |

## 6. 修复建议（按优先级，仅建议未改码）

1. **P0**：让无头开关真正生效——`:642` 改为 `if headless: opts.add_argument("--headless=new")`。
   本机配置 `headless:false` + CfT 即可回到已验证"有头 5/5 成功"的路径；预期直接消掉
   大部分 S2/S3/S4 与入口 H2。
2. **P1**：接入死代码里的两道防护——tag 点击改用 `click_chip_verified`（active 校验，
   消 R1 误归因）；恢复"分类切换前 `open_panel` 重开面板"（消长会话漂移）。
3. **P2**：软跳过升级——S3/S4/S5 在当次 run 内改为"重开面板后重试一次"，仍失败才跳过；
   汇总里输出被跳过的库/分类/tag 清单，让"爬取不全"可见。
4. **P3**：S5/S7 的 wait_any 超时 8s 可配置化并适当加大；`upload_item` 失败清单落盘
   `data/jzxz-captured/failed-<ts>.json` 供 `--upload-json` 补传。

## 附：与主文档的关系

架构、部署、命令说明见 `docs/jzxz-material-crawler.md`；本文专注"代码怎么跑、
在哪里失败"，用于诊断"总是失败/爬取不全"。
