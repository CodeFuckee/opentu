## Unreleased

### fix: 终态回写改读-合并-写，杜绝归档成果被整体覆盖（2026-09-28）

- 诊断背景：用户侧报「68 项未归档任务」。生产库解剖：67 条 completed image 的
  `result.size=0` 中，**59 条文件实际已在桶里**（真缺文件的仅 8 条）——是终态回写
  与异步归档回填的**双写竞态**，不是归档缺失。
- 根因：`task_submissions.result` 被两个写入方先后整体覆盖——任务事件触发的
  `updateTaskSubmissionOnTerminal`（task-queue-service.ts:450，每次终态事件都用内存
  副本整体落库）会抹掉归档链路稍后/已做的回填（size 真值/source_url/archived）；
  方案1 的画布插入 hook（useAutoInsertToCanvas）等归档完成后把 url 映射成公开直链
  再调 `updateTaskStatus(COMPLETED, {result})`，用的却是映射前的旧副本，二次放大覆盖。
- 修复（治本，双管齐下）：
  - `updateTaskSubmissionOnTerminal` 改**读-合并-写**：新增纯函数
    `mergeTerminalResult`——客户端副本缺失/为空的 size/source_url(s)/archived/
    public_url(s) 保留服务端值；客户端 url 仍是未归档上游地址而服务端已是归档
    交付地址（`/__aitu_cache__/` 或 bucket 路径）时保留服务端并留档 source_url；
    读失败回退客户端原样（原行为）。failed/cancelled 不读行，行为不变。
  - `useAutoInsertToCanvas` 归档映射后从归档条目**回填真值元数据**（size/
    source_url/archived.via+paths）再落库，本地任务与服务端行一致。
  - `TaskResult` 类型补声明 `source_url`/`archived`（落库 schema 早已有，类型漏声明）。
- 存量 67 条积压未动（59 条元数据缺失可从桶对象回填，8 条真缺文件需补传）——
  repair-task-media.mjs 口径仍指 huabu，待按新口径重写后再清（另批处理）。
- 测试：service.test.ts 新增 mergeTerminalResult 4 例 + 终态回写合并集成 3 例
  （mock client 扩展 task_submissions select）；本地门禁 check 0 errors /
  vitest 1514 全过 / 后端 171 全过。

### fix: 贴图爬虫错标修复——采集域白名单/网格区域锚定/tag 后缀形态/花瓣 WAF 浏览器下载（2026-09-25）

- 配景库新分类"舞台构建装置"首轮采集的 11 条素材全部错标（实际是室内效果
  图/卡通贴图）。逐张目检 + 探针取证定位四个叠加问题，全部修复：
  1. **norm_tag 不认后缀形态**：新分类请求 tag 为「<tag>.-免抠」后缀形
     （老分类是「免抠-<tag>.」前缀形），网络通道数据被 tag 匹配整批丢弃；
  2. **采集域白名单缺图床**：素材图床实测有 soutushenqi / image-assets
     / ai-assets / gd-hbimg.huaban.com（花瓣现役 CDN）多家，白名单不足
     即整批漏采；
  3. **DOM 兜底全文档扫描污染**：网格在 iframe/shadow 内本就扫不到，能
     扫到的是画布缩略条/最近项目封面/信息流等页内图——错标根源。改为以
     一级分类行为锚锁定面板网格区域（下界锚「下一页」按钮）+ 只收「分类
     点击前快照之后新出现」的图；
  4. **花瓣 CDN 有 EdgeOne WAF**：requests/curl 一律 567 拦截页，但站点
     页面内 <img> 子资源加载可过——新增 download_via_page：注入 <img> 触
     发浏览器下载 + 性能日志 CDP 取响应体（需清日志积压防缓冲满丢事件）。
- 错标 11 行已删除重采；新采条目逐张目检正确（stage-scene/ 桶路径、
  舞台花艺摆件）。**遗留：花瓣 WAF 对本机高频访问临时限流（403，连站点
  自身面板缩略图都被拦），大部分条目暂无法下载**；每日 03:00 增量定时
  会自动重试，解封后自动补齐，届时素材库 UI 自动出现该分类。
- 已知无解（上游停服）：img.hb.aicdn.com 图源约 324 条（http 405/https
  握手失败）。

### feat: 素材库支持同一素材挂多分类，配景库补"舞台构建装置"（2026-09-25）

- 数据模型：jzxz_materials 唯一键 source_id → (source_id, category)
  （迁移 jzxz_materials_multi_category.sql 已应用）。站点跨分类复用同一批
  素材文件（"舞台构建装置"的全部条目与 室内家具/办公桌 等同文件），原模型
  文件只能归首次分类，站点侧分类视图无法呈现。
- 爬虫：已知判定与 upsert 冲突键改为 (source_id, category)；跨分类重复素材
  直接复用既有桶内路径（零重复存储、零重复下载）。
- 前端：官方素材 Asset id 改用行 id（official-{row.id}）——同文件多分类行
  不再撞 id；facets/筛选零改动，"舞台构建装置" chip 由数据自动出现
  （11 条，站点该分类本就只有这批独有素材，三个 tag 展示同一批文件）。
- 本轮爬取顺带按新模型补齐 家居库 1664 / 植物库 1565 贴图行（此前与配景
  重复被跳过的部分，复用桶路径）。

### fix: 贴图爬虫枚举行尾分类漏采（连续 2 轮无新才停，2026-09-25）

- 用户实测发现配景库还有第 12 个分类"舞台构建装置"（排在总平素材之后）：
  enumerate_row_texts 原来单击后 0.6s 无新 chip 即停，swiper 尚未渲染出
  行尾新 slide 时提前收工，行尾最后一个分类被漏。改为**连续 2 轮无新才停**
  （点击重试一轮），分类与 tag 两行同受益。
- 爬取结果：舞台构建装置（3 tags，1885 条目实例）**全部与库内已有素材按
  内容重复**（探针对账实证：同一批文件此前已作为 室内家具/办公桌、家居库
  等入库，站点跨分类复用素材文件），按"首次归属"去重设计 0 新行，故素材
  库 UI 不出现该分类 chip。枚举修复保证其后续新增素材会被每日增量自动收录。
- CATE_SLUGS 补 舞台构建装置 → stage-scene。

### fix: 贴图爬虫补齐配景库 7 个缺失分类（open_panel 接线 + 采集域白名单，2026-09-25）

- 配景库此前只爬到 11 类中的 4 类，根因有二，均已修复：
  1. **分类点击对屏幕外分类必然失败**：swiper 虚拟渲染下未滚入视口的
     slide 不在 DOM，枚举阶段按文本直找 slide 找空即弃；dd1b6f08 加的
     open_panel（逐分类重开面板）只有定义从未被调用。重构为逐分类流程：
     open_panel 重开 → 回配景库 tab → chip_element 滚入可视区点击 →
     枚举 tag → 逐 tag 爬取。
  2. **HARVEST_GRID 域白名单只有 soutushenqi.com**：动物配景/总平素材的
     素材图在 image-assets.jianzhuxuezhang.com（探针实证），面板命中缓存
     不发请求时网络捕获通道为空、DOM 扫描被域过滤挡掉 → 双通道全空。
     白名单加入 image-assets.jianzhuxuezhang.com。
- 家居/植物/配景 tab 查找加 8 次重试+关弹窗（tab 行渲染慢于面板就绪判定
  时此前直接整轮跳过）；"无响应且无网格"与 tab 不可见留现场截图/JSON。
- 附带此前的未提交小改进（chrome_binary 配置、上传失败截图）一并入库。
- 全量重跑：配景库 11 类全覆盖 9338 条（新增 总平素材 1295/室内物品
  1140/人物配景 559/城市建筑 300/景观小品 236/动物配景 475/建筑构件 82），
  本轮 897 页 失败 0。已知遗留：人物配景等个别 tag 的素材图在已失效的
  img.hb.aicdn.com（http 405/https 握手失败），约 324 条无法下载，属上游
  CDN 停服，暂无解。
- 每日 03:00 增量定时任务已重新建立。

### feat: 官方素材库新增植物库 tab（产品模型库泛化，2026-09-24）

- 素材库库 tab 新增「植物库」（顺序 家居库 | 植物库 | 配景库，与建筑学长
  站点一致），数据源为 `jzxz_plant_materials`（本机植物库爬虫
  scripts/jzxz-plant-crawler.py 归档，462 条 / 20 品类），公开桶
  `jzxz-plant-materials` 直链展示与插入，迁移见
  supabase/migrations/jzxz_plant_materials.sql。
- 服务层将家居库产品模型访问泛化为「产品模型库」（ProductModelLibraryConfig
  + PRODUCT_MODEL_LIBRARIES：表名/桶/id 前缀按库区分），家居库行为保持不变；
  Asset id 前缀 植物库为 official-plant-。
- 植物库按拍板只做品类筛选（常绿大乔/球形等 chips），标签在选中条目元信息条
  展示（爬到的标签为气候区/习性/颜色混排数组，无类型划分不做分组筛选）；
  多视图预览、按视图插入、元信息条复用家居库链路；植物详情无尺寸段，
  元信息条尺寸为空时不再渲染（家居库缺尺寸同步受益）。
- 数据修复：jzxz_plant_materials 两条 category='标签:' 解析残留置空（站点
  该条目品类为空）；删除 jzxz_materials 中 61 条 gallery='家居库' 旧错误数据
  （当初接错数据源遗留，UI 此前已绕开）。
- 爬虫加固（家居/植物两脚本同改）：extract_detail 的 pick() 不再把形如
  "xx:" 的小节头当字段值（品类空值时曾把下一行"标签:"误当品类）。
- 本地门禁：drawnix tsc 0 / vitest 1507 通过 / web tsc 0 / eslint 0。

### refactor: 第八轮全仓库评审批次1——交付完整性与死代码清理（行为保持，2026-09-24）

- 评审报告：docs/code-review-2026-09-24.md（增量深评第七轮后 9 提交 + 工作区 WIP，
  1P1 交付 + 1P1 过时测试 + 2P2 修复，8 条待确认沿用/新登记）。
- **补交 ai-outputs 公开桶迁移**（supabase/migrations/ai_outputs_bucket.sql）：方案 1
  主提交（c661d76f）漏暂存了其依赖的迁移文件（该会话第二次漏暂存），生产部署将缺桶
  致画布直链全 404；内容已逐行复核幂等且与实测 RLS 语义一致，随本批入库。
- **删除过时测试** apps/web/src/supabase/auth-context.spec.tsx：测试对象是 f65a4079
  已删除的明文密码回写功能，实测对 HEAD 3/5 必挂且被 apps/web vitest 收录，阻塞本地
  全量测试门禁。
- useAutoInsertToCanvas：删除空画布回退 `?? [0,0]` 后永假的 `if (!resolvedInsertionPoint)`
  死分支（含永不触发的 warn）。
- useImageGenerationAnchorSync：锚点预览局部类型 `public_urls` 与其余三处声明对齐为
  `Array<string | undefined>`（运行时确实会写入 undefined 项，:129 的 typeof 守卫即证）。
- 本地门禁：check 0 errors / vitest 4 项目全过 / 后端 171 例全过。

### feat: 数据看板周期选择支持自然月快选（2026-09-24）

- 周期下拉新增自然月选项：按用户拍板**仅提供 2026-09 与 2026-08** 两个月
  （MONTH_OPTIONS 常量，需扩展时改此数组即可），可查看该月全量数据。
- 选月份后按该自然月精确区间请求（如 2026-08 → start=2026-08-01 &
  end=2026-08-31，东八区口径），复用既有 /overview range 参数，后端聚合零改动；
  统计周期标签显示「YYYY-MM（自然月）」，日均按当月实际天数折算。
- 看板展示倍数 USAGE_MULTIPLIER=6（configs 表，已应用生产，即时生效）：
  所有使用次数与金额按 6 倍放大展示（活跃用户数/用户数分布/额度上限/汇率
  不受影响）；运维 SQL 留痕 supabase/migrations/usage_multiplier_6.sql。
- 固定「近 30 天」口径的「近30天消耗金额」KPI 卡仅在「近 30 天」周期显示，
  其余周期（最近一周/近 90 天/自然月）页面与导出图片一致隐藏，避免口径错位。
- 以上页面与聚合改动随 dashboard-stats 函数重新部署生效。

### feat: 数据看板新增「用户使用排行」面板（2026-09-24）

- `/functions/v1/dashboard-stats/` 看板新增全量用户使用情况图表：横向条形
  排行（窗口内成功任务次数，降序，含排名/姓名/部门/次数），标题带「共 N 人」，
  位于「部门使用排行」下方，容器限高滚动（超 420px 出滚动条）。
- 数据侧 `overview.tasks.userUsage` 全量输出（原 `topUsers` 仍截断前 10，
  周报口径不变；`applyUsageMultiplier` 缩放同步覆盖）；页面渲染按数组遍历，
  同名用户不再互相覆盖。
- 测试先行（TDD）：参与聚合全量不截断/排除失败与匿名行、缩放同步、页面
  面板断言，dashboard-stats 测试 23→25 例；本地过目用 fixture 预览页确认。

### feat: AI 生图结果画布 URL 切换为公开桶直链（方案 1，2026-09-23）

- 现状：生图完成事件瞬间画布即用供应商原始 URL 插入（useAutoInsertToCanvas
  读 result.url），而归档转存是 fire-and-forget 旁路且完成后不回写画布元素，
  供应商链接过期后画布图全部失效。
- 改为"等待归档完成后插入、直接使用 bucket URL"：
  - 新增公开桶 ai-outputs（迁移 ai_outputs_bucket.sql，已应用；huabu 保持
    私有，输入图与内部副本不受影响）；
  - archiveGeneratedMediaToSupabase 固定写 ai-outputs，归档条目新增
    publicUrl（/storage/v1/object/public/ 直链，路径内容寻址 sha256）；
  - registerGeneratedMediaArchive 注册 promise，画布插入前
    waitForGeneratedMediaArchive（上限 30s）等待归档，超时/未登录/失败回退
    原 URL 立即插入（未登录行为与现状一致）；
  - 任务结果新增 public_url/public_urls 字段，素材库 AI 素材（taskToAssets）
    优先使用公开直链。
- 插入时序变化：登录态下生图完成后画布出现会晚数秒到最长 30s（等转存）。
- （修复）首次实测上传 ai-outputs 400 "new row violates row-level security
  policy"：supabase-js 上传固定带 x-upsert:true，存储端语句为
  INSERT .. ON CONFLICT DO UPDATE RETURNING *，要求 UPDATE 策略放行且
  RETURNING 要求 SELECT 放行（即使对象不存在走纯插入路径，实测同样拒绝）。
  已补 ai_outputs_authenticated_update（bucket_id 限定，不再限 owner）与
  ai_outputs_public_select 两策略（存储服务端日志定位：ExecWithCheckOptions
  42501，与用户角色无关）。

### fix: apiKey 不再经四路通道扩散（用户拍板待确认项 #1，2026-09-23）

- **第三方工具 URL 模板白名单**：`${apiKey}/${baseUrl}` 模板变量只对可信源白名单
  （当前仅内置 vercel.ddaiai.com 绘图工具）注入；随画板数据流转的任意 URL
  （导入/粘贴/自定义添加）不再注入敏感变量、也不诱导用户为其配置 Key——
  恶意分享的画板无法再把用户 Key 收割到任意第三方站点（新增 6 例单测）。
- **工具 iframe 初始化广播去掉 apiKey**：with-tool 的 BOARD_TO_TOOL_INIT
  载荷不再携带 apiKey（该消息协议在仓库内无第一方工具实现，零功能影响）。
- **URL 密钥参数支持 hash 形式**：新增 `#apiKey=/#settings=`（fragment 不进
  服务器/代理访问日志，推荐）；`?apiKey=` 保留兼容并给出一次迁移提示；
  读取后照旧立即从地址栏清除。
- **设置变更事件去载荷**：`gemini-settings-changed` 事件 detail 不再携带
  明文新旧值，只留变化路径（唯一消费方 tool-generator 本就不读值，需要时
  经 geminiSettings.get() 按需读取）。
- 已知接受风险：内置 ddaiai 工具的协议本身要求把 Key 放进其 URL fragment，
  该第三方页面可读取——建议为该用途使用受限额度的 Key。

### refactor: 第七轮全仓库代码评审——行为保持修复三批（2026-09-23）

- 评审方法与完整问题清单见 `docs/code-review-2026-09-23.md`：8 分区只读深评
  （第五/六轮之后的增量），新增 1 P0 + 8 P1 + 约 40 P2；行为改变类全部列为
  待确认/暂缓，未混入本轮修复。
- 批次 1（P0/P1 安全与正确性）：link-popup 画布链接补 `sanitizeLinkUrl` 消毒
  （存储型 XSS，正常链接零变化）；canvas-search 搜索正则去 g 标志（lastIndex
  残留导致「隔一漏一」）；workflow record-storage 复合写按 key 串行化（并发
  任务回填丢记录，附并发回归测试）；prompt-storage 三处云端合并补删除墓碑
  过滤（删除的提示词不再被云同步复活）；useChatHandler 发送锁死锁修复；
  kling 轮询查询补 200+错误体守卫；workflow-engine saveWorkflow 补 catch；
  video/audio API 失败路径 finalize LLM 日志。
- 批次 2（组件层守卫/监听/定时器卫生）：ToolboxDrawer 视口守卫与 effect
  依赖/定时器清理；MediaViewport 拖拽监听卸载兜底 + 滚轮缩放改原生非
  passive 监听（preventDefault 真正生效）；link-button setTimeout 判空；
  canvas-insertion-layout maxBottomY 初值 -Infinity（内容在 y<0 时插入点
  错位）；selection-utils 图片填充导出补 15s 超时；with-arrow-line 恢复默认
  pointerMove 链路（无 generator 不再吞 hover/框选）；CharacterTimeRange
  Selector 拖拽 mouseup 用最新值 seek；Minimap 自动隐藏定时器持续交互重置
  （修周期性闪烁）；DrawnixDeferredRuntime 异步订阅 disposed 标志（修
  StrictMode 双挂载重复事件）；with-pinch-zoom 补 pointercancel 触点清理
  （修幽灵触点致单指误入双指缩放）；popover zIndex 改默认值（调用方分层
  意图恢复）；creation-toolbar 去重 mind 配置；clean-confirm 函数式 setState；
  UnifiedColorPicker 最近颜色仅记录用户交互；text-property-panel 切换选区
  重新反显；WinBoxWindow 加载失败可重试。
- 批次 3（错误路径加固 + E2E 断言收紧）：ConfirmDialog/command-palette/
  UnifiedMediaViewer/MediaLibraryModal/WorkZoneContent/播放列表上下文
  调用点等 unhandled rejection 逐一接住并给出反馈；auth-form 提交补 catch；
  crash-logger SW 永不可用时停表降级 + 低帧率快照 60s 最小上报间隔（防刷爆
  SW 端环形缓冲）；freehand 两份 ~80 行重复轮廓函数合一；E2E 素材库/
  任务队列改弹窗/面板作用域断言（原 body 全文断言永真）、聊天抽屉收起
  缺按钮显式失败（原静默跳过）。

### feat: 素材库「家居库」切换为家居产品模型数据源（2026-09-22）

- 官方素材库家居库 tab 此前读贴图表 jzxz_materials 的家居库分区（仅 59 条
  属性筛选杂项贴图，展示内容不正确）；现改读产品模型表 jzxz_home_materials
  （爬虫归档 500+ 条真家居产品）。
- 交互：卡片显示主视图图；预览可翻看该素材全部视图图（单素材多图）；插入 =
  当前预览的视图图；选中条目在网格下方显示品类/标签/尺寸，并附 glb 模型
  下载直链（画布暂无 3D 渲染，仅提供下载）。
- 家居库品类上百个，品类 chips 行单行横向滚动；搜索匹配名称/品类/标签
  （PostgREST or+ilike+cs，supabase-js 自动包 or 括号）。
- 植物库/配景库（贴图表）行为不变；旧家居库贴图不再展示（表内保留）。
- （分组显性化）家居库卡片右下角新增"N 图"角标：一个产品一组视图图在网格
  上可辨识（AssetItem 新增可选 imageCount 徽章，VirtualAssetGrid 经
  imageCountOf 回调透传，不影响我的素材等其他使用方）；数据层本就一品
  一行一组图（906 行，行内/跨行零重复），点击预览在组内翻图不变。
- （Inspector 组图展示）选中家居库产品后，右侧详情面板新增"视图图（N）"
  缩略图组：点击任一缩略图切换主预览图，"使用/下载"跟随当前选中的视图图；
  元数据区补品类/标签/尺寸行与"3D 模型"glb 下载链接。实现：Asset 新增可选
  viewImageUrls/homeMeta 字段（homeMaterialToAsset 填充），MediaLibraryInspector
  检测到即渲染，其他素材类型不受影响。
- （修复）快捷创作工具栏打开素材库时，右侧"使用"按钮显示原始键名
  toolbar.insert：quick-creation-toolbar 走 i18n 取文案，但词典缺
  toolbar.insert/assetInserted/assetInsertFailed 三键，t() 对缺失键原样
  返回键名致 `|| '插入'` 兜底失效。已在 i18n 词典补齐三键（zh/en）。

### fix: 家居库爬虫翻页误判库尾（2026-09-22）

- `scripts/jzxz-home-crawler.py`：点"下一页"后只固定等 3s 即比对内容，
  下一页数据网络渲染慢于 3s 时被误判"内容未变化→库尾"提前停机。
  改为轮询等待变页（20s×3 次点击重试），比对签名从名称列表换为
  图片 URL 排序列表；upsert 失败自动重试一次。
- （二次修复）长会话中"下一页"点击系统性失效（ActionChains 被透明层静默
  吞掉不抛异常）：点击升级阶梯 ActionChains→原生 click→JS click 仍失败时，
  刷新页面重建面板并自动翻回当前页继续（同素材爬虫"重开面板"抗 swiper
  状态漂移思路，连续恢复上限 3 次）；最终失败落盘 pagination-fail-*.json/png 现场。
- （三次修复）长会话中"查看详情"点击同样系统性失效（整页 9 条全部进不了
  详情）：详情点击同样上三级点击阶梯（以进入详情信号验证）；连续 3 条
  失败自动重建面板翻回本页重试（上限 2 次，已入库条目快速跳过）；失败
  现场落盘 click-fail-*.json/png（含按钮中心点实际命中元素）。
- （四次修复）补采 glb 缺失行时 upsert 409（23505 duplicate key）：自托管
  Supabase 的 PostgREST 为老版本，只认旧 prefer 名 resolution=merge-duplicates，
  新名 merge-deduplicate 被静默忽略落成裸 INSERT。改用旧名后实测 200 更新成功；
  全库 56 条 glb 缺失行将在后续运行中自动补齐。
- （五次修复）变页误判引发恢复翻页刷屏：页面实际已翻页但检测未发现（网格
  图片 URL 签名单一信号失灵），恢复翻回深页时每页打一行"已点击"刷屏数分钟。
  变页检测加入翻页控件文本作为第二信号；恢复翻页静默化（每 5 页报进度）；
  阶梯失败时把点击前后两组状态（grid 签名+指示器）落盘 pagination-fail-*.json。
- （六次修复）爬到第 100 页（真库尾，仅 5 条）误判为漂移，重建面板空翻几百页
  "不断翻页"。现场数据（pagination-fail json）证实翻页控件无页码、点击前后
  状态全等 → 三级点击+双信号均无变化时直接判定库尾停机，不再重建翻回；
  另加 glb_attempts 计数列（迁移 jzxz_home_materials_glb_attempts.sql）：
  连续 3 次未拿到 glb 视为无 glb 不再重试，消除"glb: 未获取"行每轮空重采。

### feat: dev-monitor 看板新增「存储桶占用」区块（2026-09-22）

- `GET /functions/v1/dev-monitor/status` 新增 `bucketUsage`：经 PostgREST storage
  schema（`Accept-Profile: storage`）全量分页读 `storage.objects`，按 bucket 聚合
  对象数与 `metadata->>size` 字节合计；`/storage/v1/bucket` 清单补充公开/私有标志与
  空桶（清单失败降级显示 '-'）。
- 页面在「结果完整性」下新增「存储桶占用」面板：桶名/可见性/对象数/占用/相对占比条 +
  合计行；**全量口径，不随统计窗口变化**；查询失败显示拉取失败，不拖垮其余板块。
- 分页健壮性：`order=id.asc` 稳定排序，offset 按实收行数推进、空页才结束，兼容
  PostgREST `db-max-rows` 截断不漏页。
- 单测：node:test 新增 fetchBucketUsage 分页聚合/降级 3 条（dev-monitor 34 条全绿）。

### refactor: 第六轮评审批次 2——死代码与微清理（2026-09-22）

- **useMediaCache**：移除 `blobUrl` 死状态与两处 `URL.revokeObjectURL` no-op
  （`getCachedUrl` 只会返回原 URL，从不产生 blob: URL，相关清理逻辑自始为死代码）。
- **settings-manager**：三处 `getSetting.call({ settings }, …)` 伪造 this 的调用
  （解密装载/加密存储/重置默认值）改为显式 `getSettingFromBag(bag, path)` 纯参数方法，
  `getSetting` 委托之，行为等价。
- **batch-image-generation**：批量导入成功路径与 finally 各调一次 `endTrack` 导致
  trackMemory 计时被双重结束，删去 try 内那次，统一由 finally 收口。
- **image-splitter**：`catch (error: any)` 收敛为 `unknown` + instanceof 窄化。
- **scripts/jzxz-material-crawler.py**：删除重复定义的 `merge_into_result`
  （310 行与 562 行同体，后者运行时遮蔽前者）。
- 删除误提交的死临时文件 `ttd-dialog/ai-video-generation.tsx.tmp`（495 行组件旧拷贝，
  无任何引用）。
- 全部为等价变换：typecheck、全量单测通过。

### refactor: 第六轮全仓库代码评审落地批次 1——服务/变换层去重（2026-09-22）

- **评审**：按 code-review-skill 五维度清单对全仓库分区评审（supabase functions+scripts/
  apps/web+公共包/drawnix services+data+mcp+engine/drawnix hooks+utils+plugins/
  drawnix components 两分区），本批先落地**行为保持**的结构去重；行为变更类问题
  （P0/P1 安全与资损路径）另行留档待确认。
- **task-queue-service.ts**：7 段逐字复制的「模拟进度 setInterval」块提取为
  `startSimulatedProgress(taskId, config)`；2 处重复的歌词 markdown 组装提取为
  `formatLyricsMarkdown`。
- **transforms/property.ts**：17 个文本 mark 设置/切换函数的「遍历编辑器+
  setSelection+try/catch」复制骨架提取为 `forEachTextEditor`，各函数体逐字保留。
- **transforms/precise-erase.ts**：3 个橡皮擦路径扫描函数的包围盒计算与相交遍历
  提取为 `getEraserPathBounds`/`forEachIntersectingElement`。
- **utils/gemini-api/apiCalls.ts**：3 处逐字复制的上游错误响应解析+埋点+抛错块
  提取为 `trackAndThrowResponseError`。
- 全部为等价变换：typecheck、全量单测、lint 零新增告警通过。

### feat: 素材库新增官方素材库——建筑学长素材三级分类展示（2026-09-21）

- **背景**：建筑学长贴图爬虫已入库 2175+ 张素材（表 `jzxz_materials` + 公开读桶
  `jzxz-materials`，每日 03:00 增量补爬），但前端素材库无入口使用。本次在素材库面板
  主区顶部新增「我的素材 / 官方素材库」双模式切换，官方模式按建筑学长面板方式
  三级分类展示：库 tab（家居库/植物库/配景库，带计数徽标）→ 分类 chips（仅配景库）→
  tag chips → 素材网格；设计决策（展示形态/分页策略/插入行为/空分类处理）经 grill-me
  访谈逐点确认，提案见 `openspec/changes/add-official-material-library/`。
- **服务层** `packages/drawnix/src/components/official-library/`：runtime 注册表
  （宿主登录时注入 client+supabaseUrl，照抄 template-gallery 模式）；数据服务
  facets 组合分页扫描+客户端去重（5 分钟缓存，只渲染实际有数据的分类/tag）+
  素材服务端分页（每页 60，count=exact，`created_at desc, id asc` 稳定 tiebreaker）+
  公开桶直链拼接 + `OfficialMaterialRow → Asset` 视图映射（`official-` 前缀，不进
  AssetContext/IndexedDB）；链式 mock 单测 11 例锁定查询形态。
- **UI**：`OfficialLibraryView` 复用 `VirtualAssetGrid`/`AssetItem`/`UnifiedMediaViewer`；
  搜索防抖 300ms 服务端 `ilike`（名称/tag）；滚动近底自动加载下一页
  （`VirtualAssetGrid` 新增可选 `onLoadMore`）；未注册/加载失败/空结果三态降级。
- **行为**：官方素材只读——`AssetSource` 新增 `OFFICIAL`（Inspector 来源显示「官方」，
  重命名/删除/设为主体按钮按回调门控隐藏，保留下载与使用）；BROWSE 模式 + 按钮/
  预览器直插画布（`insertImageFromUrl` 自动缓存外链）；SELECT 模式「使用」回传
  宿主公开直链，不膨胀个人素材库配额。
- **接线**：`apps/web` auth-context 登录态变化时注册/注销 `configureOfficialLibrary`；
  `packages/drawnix/src/runtime.ts` 导出。本地 typecheck+lint（新文件 0 告警）+
  全仓单测通过；HTTP 内网直链可用性已实测（匿名 GET 200）。

### refactor: 第五轮全仓库代码评审落地——行为保持重构五批（2026-09-21）

- **评审**：9 分区约 30 万行（apps/web 含 SW 全量、drawnix components 三分区/services/
  utils/hooks/contexts/plugins、supabase functions+migrations、scripts+CI/部署、
  apps/web-e2e、公共包 react-board/react-text/utils），按 code-review-skill 五维度清单
  与前四轮报告逐条去重。完整报告见 `docs/code-review-2026-09-21.md`。
- **结论**：新增 1 条 P0（supabase-sync collector-core failedSources 无消费方 → 收集失败
  静默缺失被墓碑化，是已知「多设备互删」P0 的独立触角）、6 条 P1、约 60 条 P2；
  其中 **66 条行为保持问题分五批修复**（F1-F66），全部通过本地 typecheck+lint+全量
  单测，待确认/暂缓项（含在途 WIP 文件的问题）在报告中逐条留痕。
- **批次1 SW 层**（0c84b11d）：字体分支 GET 守卫（F1 同族漏网）；IDB 连接模块级缓存；
  版本状态读改写收敛单事务；调试日志 slice(-100)→slice(0,100)；cache.put×3 留痕；
  LLM 日志内存淘汰后从 DB 读回补更新（不再永久 pending）；CDN 响应校验去掉
  '404'/'Not Found' 子串误判；启动视频 URL 恢复「有变更才 setValue」守卫修活。
- **批次2 hooks/contexts/services**（b9530470）：useWorkflowControl 返回值 useMemo 化
  （修复 useTaskWorkflowSync 每键击重订阅清空事件缓冲）；删除零引用死文件
  useModelHealth.ts 与空操作 logStartupPrefetch；10 处浮动 promise 补 catch 留痕；
  useAllTracksPlaybackSources 缓存上限。
- **批次3 components**（2ea29bd6）：batch-image-generation F7 惰性化漏网；SelectionWatcher
  竞态 token 守卫；DialogTaskList 渲染期原地 sort 突变 state；TaskItem memo 失效
  （handleRegenerate useCallback 化）；ImageEditorCore/TaskItem 图片加载 cancelled 守卫；
  ChatDrawer 三处 updater 内副作用移出 + 定时器清理；music/mv 防抖落盘兜底；
  media-library/comic-creator 错误提示；audioPreviewUrl 渲染期副作用改 effect；
  GradientEditor 拖拽监听卸载清理；markdown/mermaid 非空断言防崩；KB 惰性化与流式 abort。
- **批次4 E2E/公共包/scripts**：template-gallery afterAll 补种子失败守卫；
  cloud-sync-helpers 分页拉全+确认弹窗等待；删除硬编码本机绝对路径与两个零引用死文件；
  react-board 视口恢复监听卸载清理；utils clearStore 以事务完成为准；
  reconcile 双脚本 mkstemp + psql 变量参数化防注入；reconcile-upstream 通知去重
  改推送成功后落盘（推送失败不再吞掉资损告警）；preview 脚本 replace 未命中告警。
- **批次5 supabase**：ai-proxy safeRefund 退款失败补留痕（资损路径可观测）。

### feat: 建筑学长贴图素材库本机爬虫——素材入库 Supabase（2026-09-20）

- **背景**：贴图网关 `wallpaper.soutushenqi.com` 的签名与 community 网关不同源且含
  时间因子（抓包重放 + ~1550 组参数穷举均无法复现），放弃逆向，改为**本机 selenium
  无头驱动真实页面**（签名由页面自身完成），边缘函数方案作废。
- **迁移** `supabase/migrations/jzxz_materials.sql`：新表 `jzxz_materials`
  （source_id 唯一、分类/tag/宽高/桶路径/内容哈希，RLS 登录可读）+ 公开读桶
  `jzxz-materials`（贴图选择器可直链）。已在自托管库执行。
- **爬虫** `scripts/jzxz-material-crawler.py`（本机跑，Python+Selenium，零新增依赖）：
  无头打开 home → 本地上传塞探针图触发贴图面板 → 页面注入 fetch/XHR 钩子捕获
  `wallpaper/reference` 响应 → 遍历 11 个分类 × tag chips（箭头滚动全量收集）×
  分页翻页；**双通道收割**：网络捕获 + DOM 网格扫描（面板命中内存/localStorage
  缓存时不发请求，直接收割渲染出的 img）；图片按 `{分类}/{md5}.{ext}` 内容寻址
  上传桶（upsert 幂等），元数据按 source_id upsert 表；增量跳过已知 id。
- **实测与结构修正**：两级分类仅配景库有（11 分类），家居/植物库为属性筛选直翻页；
  swiper 虚拟渲染会移除滚出视口的 slide → 配景库「滚一批、点一批、收一批」推进；
  swiper transform 导致 ActionChains 坐标偏移 → 点击前用行内箭头把目标 chip 滚入可视区；
  面板命中内存/localStorage 缓存时不发请求 → DOM 网格文档级扫描兜底（双通道合并）；
  分类切换加「子分类行出现本分类已知 tag」强校验（CATE_TAGS 种子随爬取累积）+ 重试；
  gallery tab 点击同样 active 校验；非配景库连续 3 轮零新增熔断防空转；
  execute_script 设 45s 页面超时防阻塞；第三方图床素材下载失败计 failed 不中断。
  植物配景 16 tags 全遍历验证通过；真实首爬+补爬累计入库 2156+ 张（0 失败）。
- **配置/文档**：`scripts/jzxz-crawler.local.json.example`（gitignored 本机配置，
  含 service_key）、`docs/jzxz-material-crawler.md`（架构/部署/命令/边界）。
- **每日定时**：验证后用 ZCode 定时任务执行（同模板同步模式）。

### feat: 数据看板新增「推送测试」按钮——完整周报链路推开发群（2026-09-20）

- **端点** `POST /dashboard-stats/push-test`（管理员门禁，与 push-report 同权限）：
  `pushReport` 新增 `opts.dev` 目标——configs 键 `DEV_DINGTALK_WEBHOOK`（开发群），
  **强制 `DEV_DINGTALK_SECRET` 加签**（缺失视为配置错误，不发钉钉请求），钉钉标题带
  「（推送测试）」标识；链路与生产推送完全一致（截图 → Gitee 图床 → markdown）。
- **按钮**：看板「推送」旁新增「推送测试」（悬浮提示配置要求）；按约定页面不回显
  结果——是否收到以开发群实际消息为准，失败仅落浏览器控制台/函数日志。
- **测试**：dashboard-stats 24 例全绿（新增 dev 模式：读 DEV 键不读生产键/强制加签/
  标题标识；缺 DEV_DINGTALK_SECRET 不发请求）。

### refactor: 第四轮全仓库代码评审落地——行为保持重构五批（2026-09-20）

- **评审报告**：`docs/code-review-2026-09-20.md`。按 code-review-skill 清单分 6 分区
  （apps/web 含 sw 全量逐行、巨石组件、services、逻辑层/公共包、supabase/脚本、E2E）
  评审，与前三轮报告逐条去重后新增 1 P0 + 4 P1 + 40 余 P2，全部附行号与处置标注；
  全部 P0/P1 经人工二次核实。凡需改变行为的修复（云同步墓碑误判、对账锁看门狗、
  批量视频重试无上限、页选择静默全选、DJB2 判重等）全部列入「待确认」，未经确认不动。
- **批次1（apps/web SW 层）**：音频/视频拦截分支补 GET 守卫（对照图片分支，POST 上传
  不再被强制转 GET）；videoBlobCache 写入后主动清理（纯视频会话不再只增不减）；
  控制台日志 4 个 IDB 辅助函数 `await new Promise` 让既有 catch 真正兜底；getDB 失败
  重置缓存句柄允许重试；缩略图删除同键重复 cache.put；crash-logger 死变量清理。
- **批次2（组件层）**：AIInputBar/ai-video/ai-image-generation 的 initial* 初始值解析
  useMemo 惰性化（每键击不再重读 localStorage 与 settings-manager 全量解析，首渲染
  结果不变）；batch-image-generation 撤销历史改行级浅拷贝（消除每键击含 base64 整表
  深克隆）+ O(n²) 索引化 + FileReader/提交链路错误兜底；settings-dialog 重复函数去重；
  ModelSelector TypeIcon 提模块级；ResizableDivider 拖拽监听 effect 化（卸载不泄漏）；
  FramePanel snapshot ref 写移出 updater；FrameSlideshow 定时器清理/updater 副作用
  外移/关闭逻辑去重；ComicCreator updater 副作用外移；PromptHistoryPopover useMemo。
- **批次3（utils/services）**：image-splitter 插入点函数改委托 selection-utils；
  gemini-api/auth 自执行块改委托 initializeSettings（删 15 行逐字重复）；三份
  DEFAULT_FRAME_NAME_REGEXP 收敛到 types/frame.types.ts；fallback-executor 死变量
  t0 清理；sync-engine 两处静默失败补 warn；workflow-engine resume 并发双执行窗口
  封堵；SupabaseSyncContext failed 列表不再静默丢弃。
- **批次4（E2E 辅助）**：probeRemoteMediaObject 0 行时 rowFound 语义修正；template-seed
  删除注定失败的 `in.(select ...)` 首请求。
- **批次5（批量生成）**：ComicCreator 6 处 persistPatch 浮动调用补 .catch 留痕；
  两个 GeneratePage 的 ensureBatchId 移入 try，失败时 finally 复位批量锁，
  「全部→生成视频」按钮不再被永久卡死。
- **测试**：每批次后 `pnpm test` 全量通过（4 项目 1483 用例 + 23 跳过）；
  `pnpm check`（typecheck 5 项目 + lint 0 错误）全绿。

### refactor: 第三轮全仓库代码评审落地——行为保持重构两批（2026-09-19）

- **评审报告**：`docs/code-review-2026-09-19.md`。按 code-review-skill 清单分 6 分区
  （supabase、services/mcp、逻辑层、components、外围包/顶层、scripts/E2E/部署）评审，
  与前两轮报告逐条去重后新增约 50 条发现（P0×2 新增、P1×8、其余 P2），全部附行号与
  处置标注；对 09-18 两批重构修复项做回退抽查（全部在位）。凡需改变行为的修复
  （supabase 配额 RPC revoke 漏 PUBLIC、reconcile 双退、同步失败仍推进 lastSyncTime、
  precise-erase 形状几何、归档把任意 URL 当参考图、copyBoard 空副本、scripts 退出码
  三件套等）全部列入「待确认」，未经确认不动。
- **批次1（资源清理与可观测性，行为保持）**：
  - `utils/selection-utils.ts`：`copyFillDefsToElements` 第二遍 Promise.all 失败时
    先移除已插入的 defs 克隆再抛出，不再残留污染导出 SVG（成功路径不变）。
  - `contexts/ModelHealthContext.tsx`：Provider mount effect 加 `!intervalRef.current`
    守卫，消除"子组件先建轮询、父 effect 覆盖句柄"导致的定时器双份泄漏。
  - `components/ai-input-bar/AIInputBar.tsx`：SelectionWatcher mouseup 的 50ms
    setTimeout 句柄纳入卸载清理。
  - `services/ppt/ppt-export-service.ts`：元素级静默 `catch { void err; }` 改为
    console.warn 留痕，容错语义不变。
  - `mcp/registry.ts`：useSW 死开关与"SW 优先委托"误导注释如实化（接口不变）。
- **批次2（纯结构/性能，行为保持）**：
  - `drawnix.tsx`：画板 options 提升模块级常量、34 项 plugins 数组改 `useMemo`
    （updateAppState 稳定引用），不再每次渲染重建并重复调用插件工厂。
  - `transforms/clipper-shared.ts`（新增）：boolean 与 precise-erase 两份逐字重复的
    clipper 类型声明/CLIPPER_SCALE/loadClipperLib/坐标转换（约 80 行）抽共享（超集
    类型），两文件改导入；各自 `getShapePolygon` 分叉保持原样（几何合并属行为变更）。
  - `transforms/boolean.ts`：booleanFlatten 函数体与 booleanUnion 逐字相同，改为
    委托复用，导出结构不变。
  - `utils/selection-utils.ts`：两处双重循环内 `includes` O(n²) 改 Set 哈希
    （remaining 过滤与派生数组口径严格互补）。
  - `.dockerignore`：追加 `secret.md`（真实凭据）与 `test-files/`，不再进入 Docker
    构建上下文（交付镜像本就不含，上下文卫生加固）。
  - `scripts/generate-manual.ts`：markdownToHtml 的 alt/href/链接文本内插前经
    escapeHtml 转义（可信文档，纯加固）。
- **测试**：typecheck 5 项目全绿；`pnpm test`（4 项目 1483+ 用例）批次1/批次2 后
  各跑一次全绿；详见评审报告处置清单。

### feat: 开发看板成功率/平台错误率趋势 sparkline 双卡（2026-09-18）

- **DailyTrendPoint 扩展**：每日聚合新增 completed/cancelled/platformFailed 与派生的
  当日 successRate / platformErrorRate；分母口径与页首总口径一致
  （成功率分母含 cancelled，平台错误率排除余额/上游失败），分母 0 为 null。
- **看板**：任务管线下新增「成功率 / 平台错误率趋势」双卡，内联 SVG sparkline
  （跟随页面统计窗口，悬浮单日看数值），附当前值、环比（pp）与无任务天数；
  分母为 0 的天显示 '-' 且折线断开，不虚构数据。
- **测试**：daily 断言更新 + 新增当日口径用例（余额失败不计平台分子、
  仅 submitted 的天双率 null），dev-monitor 32 例全绿；预览 mock 同步。

### feat: 开发看板新增「失败归因」板块——细分分类 + 占比 + 最近出现时间（2026-09-18）

- **细分归因**：在三分类（余额/上游/平台，平台错误率口径不变）之上新增 8 类细分
  （余额不足 / 上游超时 / 上游网关5xx / 其他上游错误 / 处理超时 / 认证令牌失败 /
  内容审核拒绝 / 其他平台错误），新增关键词组（超时/认证/内容审核）；
  每个细分类带 rollup 归并，合计与 `failureCategories` 严格一致（口径自洽，测试断言）。
- **每类聚合**：次数、占比（分母=窗口 failed）、最近出现时间（completed_at ?? created_at
  取最大，页面显示相对时间、悬浮绝对时间）、最近错误摘要（summarizeError 截断）。
- **看板**：失败样本下方新增「失败归因」表（类别/归并/次数/占比/最近出现/最近摘要），
  零计数类别占位显示；`classifyFailureDetail` 关键词优先级与三分类同源
  （余额 → 上游关键词 → 认证 → 审核 → 超时 → 平台）。
- **测试**：`core.test.ts` 新增 classifyFailureDetail 断言与 failureBreakdown 聚合用例
  （计数/占比/lastSeenAt 取最大/样本跟随最近一条/零计数占位/rollup 合计一致性），
  dev-monitor 31 例全绿；预览 mock（scripts/preview-dev-monitor.mjs）补充板块数据。

### refactor: 全仓库代码评审落地——行为保持重构两批（2026-09-18）

- **评审报告**：`docs/code-review-2026-09-18.md`。按 code-review-skill 清单分 10 个分区
  （apps/web、drawnix services/components/hooks/state、utils、公共包、supabase 函数与
  迁移、scripts）逐文件评审，五维度（架构/性能/安全/质量反模式/常见 bug），约 170 条
  发现；关键 P0/P1 均经人工二次核实。凡需改变行为的修复（明文密码入库、newapi-key
  `oaAccount` 无归属校验、未加载画板空桩回写丢数据、API Key 下发第三方工具 iframe、
  对账退款非原子等）全部列入「待确认」清单，未经确认不动。
- **批次1（transforms/utils，行为保持）**：
  - `transforms/distribute.ts`：水平/垂直等间距分布两份逐字重复实现参数化为
    `distributeAlongAxis`（对外导出不变）。
  - `utils/settings-manager.ts`：Tuzi original/mix/codex 三份构建器合并为
    `buildTuziProfileVariant`（保留原方法名与调用点；Business 版差异大未动）。
  - `utils/gemini-api/message-utils.ts`：删除两处「两分支完全相同」的三元与被 `/`
    前缀判断覆盖的冗余分支。
  - `utils/common.ts`：`getShortcutKey` 删除三个 no-op replace。
  - `utils/task-utils.ts`：删除全仓库无引用的 `hasAsyncImageInvocationRoute` 与未使用
    的 `isAsyncImageModel` 导入。
  - `utils/selection-utils.ts`：图形/非图形两次全量 `filter` 合并为一次遍历分区；
    `convertElementsToImage` 排序 comparator 内的 `findIndex` O(n²) 改为预建 id→index Map。
  - `utils/runtime-model-discovery.ts`：`setCatalogState` 中 `normalizeSelectedModelIds`
    同参数重复计算两次合并为一次。
  - `utils/photo-wall-splitter.ts`：连通域 BFS 的 `queue.shift()` O(n) 搬移改为头指针，
    消除大图 O(n²) 退化（输出顺序不变）。
  - `data/audio.ts`：字符循环内联正则提为模块常量。
- **批次2（components/hooks/web，行为保持）**：
  - `MediaLibraryModal`：双击插入与「使用」按钮两份完全相同的回调合并为一个。
  - `ProjectDrawer`：PPT 编辑器打开事件 if/else 两分支相同，统一无条件进 frames 面板。
  - `EnhancedChatInput`：`hasExplicitContent`/`hasSelection` 同义重复变量合并。
  - `useTaskQueue`：`totalCountAtom`/`loadedCountAtom` 重复派生合并为同一 atom。
  - `useChatSessions`：`createSession` 依赖数组移除无实际引用的 `sessions.length`。
  - `Minimap`：合并配置对象改 `useMemo`（避免依赖它的回调与 100ms interval 每渲染拆除
    重建）；触摸结束的 500ms 隐藏定时器登记句柄并在卸载时清理。
  - `VirtualTaskList`：组件体内定义的 `LoadMoreIndicator` 改为 JSX 元素变量，消除每渲染
    因组件身份变化导致的子树重挂载。
  - `AIInputBar`：`initialPreferences` 改 `useMemo`，不再每次渲染重读 localStorage
    （全部消费点均为 useState/useRef 初始值语义，首渲染结果不变）。
  - `apps/web`：crash-logger 删除死变量 `frameCount`；`channel-manager` 构造器删除对刚
    创建空 Map 的 no-op `clear()`；`permissions-policy-fix` 的 beforeunload 引用由单变量
    改 Set 记录（多注册者不再互相覆盖，拦截行为不变）。
- **验证**：`pnpm check`（typecheck+lint）与 `pnpm test` 全量通过。

### fix: 生图归档链路重试加固 + result.url 替换为稳定地址（size 真值回填）+ 存量修复脚本（2026-09-17）

**背景**：生成交付依赖上游（tuzi）URL 直连，上游抖动导致前端下载要重试多遍、
中途中断；归档是浏览器旁路 fire-and-forget（无重试、静默失败），bucket 副本随同丢失；
且所有任务完成路径硬编码 `result.size = 0`，真值从未测量。

- **归档重试加固**（`packages/drawnix/src/services/task-supabase-archive/service.ts`）：
  `archiveGeneratedMediaToSupabase` 的上游下载改为 4 次指数退避重试（1.5s/3s/6s），
  并做媒体魔数校验——上游抖动时常见的 200 + HTML 错误页按失败重试，不再误入 bucket。
  根因修复：`core.ts` 的 `sniffMimeFromBytes` 原本对未知字节兜底返回 `image/png`，
  现改为严格模式（未知返回空串），b64 分支调用点显式回退 `image/png` 保持旧行为。
- **归档成功后回写 result（交付走自己的副本）**：bucket 上传成功后，
  同一份字节以内容寻址虚拟路径缓存本地（`/__aitu_cache__/<type>/content-{sha256}.{ext}`，
  与 b64 结果既有约定一致），任务 `result.url` 替换为该路径，`result.source_url` /
  `source_urls` 保留原始上游 URL（调试用），`result.size` 写真实字节数，`result.archived`
  记录归档信息。本地 IndexedDB 任务（`taskStorageWriter.updateTaskResult` 新方法）与远端
  `task_submissions.result`（读-合并-写）同时回写，先本地后远端，与终态回写任意时序收敛。
  说明：huabu bucket 为私有（per-user RLS），前端无裸存储 URL 渲染路径，故沿用 b64
  结果的稳定虚拟地址约定；bucket 副本 + `response_file_paths` 保证服务端可随时找回。
- **修复脚本** `scripts/repair-task-media.mjs`（dry-run 默认，`--apply` 生效）：
  服务端补齐存量 completed 图片任务的归档缺口——`response_file_paths` 缺失/对象损坏时
  从 `result.url` 重试下载（5 次退避，魔数校验）上传 huabu，回写
  `response_file_paths` / `result.size`（真值）/ `result.source_url` / `result.repaired` 标记；
  幂等可重跑；不改动存量 `result.url`（生成设备已按旧地址渲染/缓存）。
  PATCH 用 `Prefer: return=representation` 带回更新后的行做回读校验（`[ok]` 以服务端
  确认 `repaired` 写入为准）；修复 api() 辅助函数对预序列化 body 二次 stringify 导致
  PATCH 载荷变 JSON 字符串、PostgREST 返回 2xx 但不更新任何列的 bug（本地 mock Supabase
  冒烟验证通过）。
- **测试**：新增 `archive-generated-media.test.ts` 4 例（重试成功后本地/服务端回写、
  重试耗尽静默放弃、HTML 毒化响应不入桶、b64 结果 size 回填），
  `core.test.ts` 更新严格 sniff 断言；task-supabase-archive + media-executor 8 文件 97 例全绿。

### feat: user_profiles 新增 password 字段记录 Supabase 账号密码（2026-09-17，开发者测试用）

- **迁移**：`supabase/migrations/user_profiles_add_password.sql` 给 `public.user_profiles`
  增加 `password text` 列（明文，沿用 newapi_password 的自托管内网先例）；RLS 不变，
  普通用户仍只能读写自己的行，读取全部用户密码需 service_role / 数据库直连权限。
  执行：`docker exec -i supabase-db psql -U supabase_admin -d postgres < supabase/migrations/user_profiles_add_password.sql`。
- **回写时机**：注册（`signUp`）与登录（`signIn`）成功后由前端 fire-and-forget
  upsert `{ user_id, password }`（登录成功即证明密码当前有效，管理员改密后再次登录可自动刷新）；
  回写失败仅 console.warn，不阻塞注册/登录（`apps/web/src/supabase/auth-context.tsx`）。
- **测试**：新增 `apps/web/src/supabase/auth-context.spec.tsx` 5 例（注册/登录成功回写、
  失败不回写、回写失败不阻塞），web 子项目 test/typecheck/lint 全绿。
- **文档**：`docs/user_profiles_password.md`（用途、安全边界、执行与验证）。
- ⚠️ 明文密码属高敏数据，仅建议内网/测试环境使用；对外开放前应清空该列。

### 🧹 全仓库代码评审 + 行为保持重构（2026-09-17，code-review-skill 五维度）

9 个区域并行评审（supabase 边缘函数 / web 应用壳与 SW / utils·react-board·react-text /
drawnix services 根与子目录 / 核心组件 / 功能组件 / hooks·contexts·engine / utils·plugins·mcp，
合计约 37 万行），产出约 150 条发现；本次落地 5 批行为保持或安全加固型修复，
每批均通过本地全量测试 + typecheck + lint：

- **fix: P0 安全加固（1081db14）**
  - 知识库笔记来源链接与任务结果链接 `<a href>` 未校验协议，`javascript:` URL 可点击执行
    （存储型 XSS）→ 提取共享 `link-url-sanitize`（MarkdownReadonly 同款白名单：http/https/mailto），
    KBNoteEditor 两处、TaskItem 一处接入。
  - 工具 iframe 图片生成**错误路径** `postMessage(response, '*')` 通配 targetOrigin
    （成功/失败路径均已校验 origin）→ 统一 `getToolIframeTargetOrigin(iframe)`。
  - SW 能力通道 `svgToDataUrl` 与 mcp svg-tool 的 LLM 生成 SVG 未消毒 → utils/svg-utils
    新增 `sanitizeSvgForEmbed`（剥 `<script>`/`<foreignObject>`/`on*` 事件属性/`javascript:` href），
    `svgToDataUrl` 出口统一消毒；sw-capabilities/handler 重复的私有 SVG 工具函数改为复用共享实现。
  - `@aitu/utils` `encrypt()` 加密失败静默降级为可逆 Base64，调用方会把明文当"已加密"数据
    持久化/导出 → 改为抛错（fail-fast；decrypt 仍兼容历史 fallback 数据）。
- **fix: 基础库 P1（c6565232）**：`splitRows` cols≤0 死循环；IndexedDB `putMany`/`deleteMany`
  缺 `onabort`（事务显式 abort 时 Promise 永不 settle）、`deleteById` 请求成功即 resolve 过早报成功；
  `throttle` 首次调用后前缘永久失效（inThrottle 永不复位，退化为纯尾缘）；`dataUrlToBlob`
  对无逗号输入 `atob(undefined)` 裸抛；`extractVideoFrame` 对直播流 NaN/Infinity duration
  干等 30s 超时（现立即失败并给明错误）；透明图被强制 JPEG 编码变黑底四处
  （`compressImageWithQuality`/`trimImageWhiteAndTransparentBorder`/`removeWhiteBorder`/
  drawnix 宫格拆图与去白边，现按源图 alpha 保留 PNG/WebP，新增 `detectImageHasAlpha`/
  `pickCompressOutputType` 共享助手）。
- **fix: 服务层 P1（3370fa32）**：音频轮询把上游终态失败当临时错误退避重试 10 次
  （对齐 video-api 的 isBusinessFailure 模式）；提示词缓存初始化完成前落盘用空数组覆盖
  IndexedDB 真实历史（6 个 save* 函数初始化前跳过写盘）；`updateTaskStatus` 对不在内存的
  任务创建的存根（空 params）不再落盘覆盖真实记录；统一缓存 DB 打开失败后 rejected promise
  被永久缓存导致本会话读写全废（现置空允许重试）、SW 通道等待轮询加 60s 上限、
  缓存压缩同样保留透明度；`resumeVideoGeneration`/`resumeAudioGeneration` 超时定时器
  句柄未保存永不清理（对齐图片恢复路径 finally 清理）；workspace `saveState()` 四处裸调用
  补 `.catch` 消除 unhandled rejection。
- **fix: hooks/组件层 P1（484c99fb）**：聊天流式发送的 done/error/content 回调在用户切换
  会话后仍写入新会话的 messages/rawMessagesRef（现以 sessionIdRef 判过期，存储写入仍归属
  原会话）；`useSetPointer` 用渲染期捕获的整份 appState 覆盖回滚其它已更新字段（改函数式更新）；
  会话删除在 `setSessions` updater 内执行副作用（StrictMode 双执行风险，移出 updater）；
  ChatDrawer workflow 订阅在动态 import 完成前卸载则永不退订（disposed 标志）；
  知识笔记上下文选择器加载失败吞成 unhandled rejection（补 catch 留痕）；
  WorkflowEngine 工具超时判负后执行 Promise 迟到 reject 成为 unhandled rejection（空 catch 兜底）；
  ChatDrawerContext（包裹整树）Provider value memo 化减少全消费者连锁重渲染。
- **refactor: P2 清理（62abe46f）**：删除空实现死代码 `logImageAdapterSelection`；
  SW `withTimeout`/`withTimeoutError` settle 后清理定时器（避免悬挂 timer 延缓 SW 终止）；
  `substr`→`slice`（废弃 API，workflow-submission-service ×2、MermaidRenderer）；
  `withPinchZoom(board)` 返回值显式赋值（与其余插件组合方式一致）；
  `stableSetAppState` 恒等双分支化简；`parseInt` 补 radix。

新增回归测试：`link-url-sanitize`（13 用例：协议白名单/控制字符混淆/blob/file 拒绝）、
`svg-utils` 消毒 7 用例、`throttle` 静默期后前缘恢复、`splitRows` cols≤0 不挂起、
`dataUrlToBlob` 缺载荷明确报错。评审确认**不改**的项与需产品决策的行为变更清单
（supabase newapi-key/sync-staff-profile 的 oaAccount 服务端绑定、configs/ai_templates RLS
迁移、视频/视频 adapter AbortSignal 贯通、ai-proxy 端点白名单、check-email/check-register
限流等）见评审报告。

### 🐛 Bug Fixes

- **纯 HTTP 内网部署（预览 8089/生产 8088）素材库图片全部损坏且控制台刷 404**
  （2026-09-16，预览环境实测复现 + LAN IP 构建产物 E2E 验证）：
  非安全上下文（isSecureContext=false）没有 Service Worker 与 Cache Storage，
  图片应走「IndexedDB 兜底 blob → blob:URL」降级链，但链路被两处缺陷掐断——
  1. `RetryImage` 虚拟路径判断用 `startsWith('/')`，而 `useThumbnailUrl` 给
     虚拟路径加 `?thumbnail=large` 时经 `new URL().toString()` 转成**绝对 URL**，
     判断失效 → 降级不触发 → `<img>` 直指虚拟路径必然 404。现改用共享的
     `isVirtualMediaUrl()`（按 pathname 判断，相对/绝对均可）。
  2. `<video>/<audio>`（预览器、素材库视频缩略图）不经 RetryImage，直指虚拟
     路径同样 404。新增 `useVirtualMediaObjectUrl` hook：SW 不可用时从兜底库
     读 blob 转 objectURL，MediaViewport 与 VideoPosterPreview 已接入。
  连带加固与清理：
  - bootstrap 的 `hasServiceWorkerSupport` 只查 `'serviceWorker' in navigator`，
    SW API「存在但为 undefined」的环境（扩展注入/旧 shim）会因 register
    TypeError **整个应用启动崩溃**；现额外校验 `register` 可用。
  - 模板中心「复制提示词」按钮裸调 `navigator.clipboard`（非安全上下文必然
    静默失效），换用带 execCommand 降级的 `copyToClipboard`。
  - `useThumbnailUrl` 在无 Cache API 环境下缩略图生成反复抛 ReferenceError
    告警，入口处直接跳过。
  E2E 新增 E2E-106「非安全上下文（无 SW/Cache API）上传图片仍可见」（addInitScript
  删除 SW/Cache API 模拟），并在 `http://10.37.80.175:7300` 真实非安全上下文
  生产构建产物上全量验证通过。已知边界：云端同步但本机无二进制的素材会显示
  「加载失败/需下载」占位（不再刷 404），跨设备自动重新拉取另行立项。

### 🧪 Tests

- **新增素材库图片可见性 E2E 测试**（2026-09-16，`apps/web-e2e/src/functional/media-library-images.spec.ts`，
  5 用例 ×Chromium，两轮无头自测全绿 + 用户有头确认）：
  单张上传后网格图片真实解码可见（`naturalWidth > 0` 且无「加载失败」错误态）、批量上传
  3 张全部可见、双击预览大图加载成功并可关闭、刷新页面后图片持久化仍可见（IndexedDB +
  SW `/__aitu_cache__/` 缓存回放）、紧凑/列表视图切换后图片仍可见。测试数据用零依赖自绘
  PNG 生成器 + 唯一前缀命名，afterEach 搜索前缀批量删除自清理，不污染测试账号数据。
  运行：`cd apps\web-e2e && npx playwright test --project=functional media-library-images --headed`
  （注意文件过滤参数用纯文件名子串，Windows 反斜杠路径中 `\f` 会被解析为正则换页符转义
  导致 `No tests found`）。报告见 `apps/web-e2e/reports/media-library-images-report.md`。

### 🔒 Security

> 本节由一次全仓库代码评审（code-review-skill 五维度：架构/性能/安全/反模式/常见 bug）产出，
> 均为行为保持或安全加固型修复；需产品决策的行为变更项见评审报告「待确认」清单。

- **[P0] Supabase 用户角色与管理员门禁统一（看板/dashboard-stats 只允许管理员查看）**
  （2026-09-16，grill-me 方案收敛后落地）：
  - **角色列**：`user_profiles` 新增 `role` 列（`'admin'`=管理员，NULL=普通用户），
    迁移 `supabase/migrations/user_roles_is_admin.sql`。配套**收权**：原 RLS 允许用户
    insert/update/delete 自己的行（存在"删行重插 role='admin'"自提权路径），现 revoke
    客户端全部写权限（写路径本就全走 service_role 边缘函数），另加 guard 触发器纵深
    （用户 JWT 上下文写 role 一律置空）。
  - **统一判定**：数据库安全定义者 RPC `is_admin()`——`role='admin'` 优先，configs
    历史名单（`TEMPLATE_CRAWLER_ADMINS`/`TASK_MONITOR_ADMINS`，逗号分隔 oa 账号）
    兼容回退，异常 fail-closed。dashboard-stats / template-crawler / task-monitor
    三个函数全部切到该 RPC（此前每函数各维护一份名单，现单点在 DB）。
  - **看板三端点全锁**：页面 HTML、`/overview`、`/push-report` 均要求「有效用户 JWT
    + is_admin()=true」（未登录/无效 401，非管理员 403）；页面自带 oa账号+密码登录
    （与主应用同规则：纯账号拼 `@yjk.com`），access token 过期自动用 refresh token
    续期，403 明示「仅管理员可查看」；`/push-report` 请求同步带凭证。移除
    `DEFAULT_ANON_KEY` 硬编码兜底，`SUPABASE_ANON_KEY` 缺失时函数拒绝启动。
  - **存量管理员自动迁移**：迁移 SQL 把现有 configs 名单中的 oa 账号批量刷成
    `role='admin'`，现有管理员零操作平滑过渡；此后任命/撤销管理员唯一入口：
    `update user_profiles set role='admin' where oa_account='...'`。
  - **部署顺序（重要）**：先在库上执行迁移 SQL，再部署三个边缘函数与看板；
    顺序颠倒会造成 `is_admin()` 缺失 → 全部调用 fail-closed 403（含每日爬虫同步）。
    另需确认 functions 容器已注入 `SUPABASE_ANON_KEY` 环境变量。

- **[P0] 工具 iframe 同源 XSS**：工具卡片 `src` 直接取自画板元素 `element.url`
  （粘贴/导入画板数据即可注入），`javascript:` URL 会在继承父源的 iframe 中执行。
  `tool.generator.ts` 现仅接受 http(s) 协议（非法协议进入加载失败态）。
- **[P1] 工具 iframe postMessage 双向加固**：出站消息 targetOrigin 由 `'*'` 改为
  iframe src 的源（`tool-communication-service.ts` / `with-tool.ts`）；入站消息校验
  `event.source === iframe.contentWindow` 且 origin 与 iframe src 一致，页面内任意
  第三方 iframe 无法再伪造 INSERT_IMAGE / GENERATE_IMAGE 等消息。
- **[P1] 工具 iframe 内部组件错误文案 XSS**：`element.component`（画板数据）此前经
  `innerHTML` 拼接渲染，改为 `textContent`。
- **[P1] Mermaid 渲染消毒**：聊天面板 mermaid（securityLevel loose，允许标签内 HTML）
  的输出 SVG 在进 `innerHTML`/预览弹窗前先剥离 script/iframe/object/embed 节点、
  `on*` 事件属性与 javascript:/vbscript: 链接。
- **[P0] newapi-key / sync-staff-profile 边缘函数补鉴权（IDOR）**：两函数此前无任何
  鉴权，凭请求体 `userId` 即可冒领他人上游 apikey / 覆盖任意用户 `user_metadata`。
  现要求 Bearer 用户 JWT（GET /auth/v1/user 自证）且 `body.userId` 必须等于认证身份；
  前端本就经 `supabase.functions.invoke` 自动携带 JWT，合法调用不受影响。另修复
  `user_id=eq.${userId}` 未编码的 PostgREST 参数注入并加 UUID 校验。
- **[P1] check-email 正确性**：此前只拉第一页（1000 条）auth 用户本地匹配，用户数
  超页后已注册邮箱被误判为未注册；改为分页遍历（50 页安全上限），不满一页即止。
- **[P1] SW 视频/音频下载改用原始 URL**：`handleVideoRequest`/`handleAudioRequest`
  此前用剥离 token/signature 参数的归一化 URL 发起下载，签名 URL 必然 403；
  归一化 URL 现仅作缓存键。
- **[P1] SW 调试日志脱敏**：XHR 调试拦截将请求/响应头（含 Authorization）与 JSON
  请求体原样写入 debugLogs，现复用 `sanitizeObject`/`sanitizeRequestBody` 脱敏。
- **[P0] secret.md 下架**：含 Supabase 凭据的 `secret.md` 移出 git 跟踪并加入
  .gitignore（历史与凭据轮换需另行处理）。
- 调试控制台 `addDebugLog` 由 `innerHTML` 改 `textContent`（全局可达 XSS sink）；
  视频点击 `window.open` 显式传 `noopener`。
- **[P1] task-monitor 边缘函数补管理员门禁**（2026-09-16 增量评审发现）：该函数此前
  仅验证 JWT 有效性，任何登录用户即可经 service_role 绕过 RLS 查看全站用户的
  生图任务失败明细（错误信息/任务 id/时长），与 template-crawler 的管理员约束不一致。
  现要求管理员名单：configs 表 `TASK_MONITOR_ADMINS`（未配置时回退共用
  `TEMPLATE_CRAWLER_ADMINS`，已列名的管理员零配置不受影响）；名单查询失败时
  fail-closed 拒绝。部署后如需授权新管理员，在 configs 对应键追加 oa 账号即可。

### 🐛 Bug Fixes

- **模板中心列表加载竞态**（2026-09-16）：快速切换分类/搜索/排序时，先发出但后
  返回的过期响应会覆盖新结果（显示与筛选条件不符的模板列表）；现按请求序号丢弃
  过期响应。
- **模板列表翻页稳定性**（2026-09-16）：主排序键（usage_count/crawled_at）并列时
  PostgREST 行序不定，翻页会出现重复/漏行；追加 `id` 升序作稳定 tiebreaker。
- **template-crawler 增量查询参数编码与封面上限**（2026-09-16）：
  `fetchExistingState` 的 `source_id=eq.${sourceId}` 未做 URL 编码，上游 id 含
  特殊字符时过滤器失效；现 `encodeURIComponent`。封面转存加 15MB 上限（防异常
  上游撑爆边缘函数内存）。模板参考图（「去创作」带入）改并行下载（Promise.all
  保序，单张失败不阻塞）。

- **生图任务超 1 分钟必失败（WorkerRequestCancelled，服务器侧修复）**：自托管 Supabase
  主 worker 脚本（服务器 `volumes/functions/main/index.ts`）创建 user worker 时硬编码
  `workerTimeoutMs = 60_000`，同步生图在上游等待超 60 秒即被 supervisor 终止，客户端收到
  `500 {"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}`
  （`msg` 键不被前端 `readErrorMessage` 识别，任务表折叠为
  「Tuzi GPT Image request failed: 500」），而上游 tuzi 侧生成本身照常完成并计费
  （ai-proxy 预扣额度因走不到「上游 ≥400 退回」分支被白扣）。服务器侧已改为
  **15 分钟**（与前端 `IMAGE_GENERATION_TIMEOUT_MS` 对齐），并同步放宽 Envoy
  `/functions/v1/` 路由 `timeout: 150s→920s`、显式 `stream_idle_timeout: 0s`
  （Envoy 默认 300s 流空闲超时会在无字节流动的生图等待期先杀连接）。
  已验证：120s sleep 测试函数修复前必死于 60s、修复后 200 返回；ai-proxy
  `/v1/models` 冒烟 200。本仓库无代码改动，变更记录见
  `docs/ai-proxy-edge-function.md`「超时配置」；服务器两文件备份 `*.bak-20260915`。
- **工具任务取消泄漏**：`with-tool.ts` GENERATE_IMAGE 订阅在任务 cancelled 时退订
  （此前仅 completed/failed，取消任务会让订阅永久泄漏）；工具通信服务的清理定时器
  句柄保存并在 `destroy()` 清理。
- **SW 任务批量保存 Promise 丢失**：同一 task 在 50ms 批量窗口内二次 `saveTask`
  会覆盖前一 waiter，调用方 Promise 永远 pending（挂到 120s RPC 超时）；改为
  按 id 保存 waiter 数组，flush 时全部 settle。
- **画布自动保存防抖**：`handleBoardChange` 此前每次 change 事件全量写 IndexedDB
  （拖拽期间写风暴），现 400ms trailing 防抖（关闭场景由 close snapshot 兜底）。
- **SW withTimeout 定时器清理**：`sw/index.ts` 与 `sw-channel/client.ts` 的超时包装
  在先 settle 一方 clearTimeout，不再每请求遗留悬挂定时器。
- **posthog 等待轮询上限**：`bootstrap.tsx` 两处无限轮询 `window.posthog` 加 40 次
  重试上限（广告拦截场景不再常驻定时器）。
- **工作流循环检测误报**：`loop-detector` 的参数哈希此前用顶层键列表作
  JSON.stringify replacer 白名单，嵌套对象键全被丢弃（不同参数同哈希），
  `forceTerminate` 会误杀正常任务；改为递归键排序。
- **工作流 JSON 解析崩溃**：`parser` 对 `args: null` 放行导致下游 `Object.keys(null)`
  崩溃；注释剥离正则会截断字符串里的 URL（"https://a.com"），改为字符串感知扫描。
- **react-board stale closure**：`wrapper.tsx` 的 `BOARD_TO_AFTER_CHANGE` 仅首帧注册，
  父组件后续传入的内联 `onContextChange` 永不生效（数据变更通知静默失效）；回调进
  effect 依赖并复用既有清理函数重注册。
- **图片压缩 >25MB 死代码**：`compressImageBlobWithStats` 的超限抛错不可达
  （>25MB 落入 small 策略被提前返回静默跳过压缩），检查移至 shouldCompress 之前，
  与 `compressImageBlob` 的「>25MB 抛错」约定对齐。
- **双指缩放除零**：`with-pinch-zoom` 两指起点重合（lastDistance=0）时 zoom 跳满，
  现保持原缩放。
- **IndexedDB put 提前 resolve**：`utils/indexeddb` 的 `put` 在 request.onsuccess 即
  resolve，事务其后 abort（配额超限）会谎报持久化成功；与 `putMany` 一致改监听
  transaction.oncomplete/onabort。
- **编码/格式化边界**：`base64ToBlob` 非法 data URL 抛明确错误（原双非空断言抛
  TypeError）；`formatSize`/`formatFileSize` 单位索引钳制（0<byte<1 与超大值原输出
  "undefined" 单位）；`getBrowserName` Opera（OPR UA 含 Chrome）误报 Chrome，调整
  判断顺序；`dom.download` 延迟 revoke ObjectURL（Safari 立即 revoke 会中断下载）。
- **Supabase 同步**：`pushToRemote`/`pullFromRemote` 补 `inProgress` 互斥守卫（防与
  自动同步交错写）；push/pull 后同步 `syncRef.current.last` 基线并持久化（否则下轮
  自动同步用旧基线制造假冲突）；`softDeleteRemoteEntities` 按 entity_type 分组
  `.in()` 批量打墓碑（原逐条串行 HTTP）；`collectChat` 消息并行读取（原 N+1 串行）；
  全量媒体同步补 50MB 上限（与 adapter 一致，超大 blob 不再必失败刷 failed）；
  同步 `deleted` 统计修正（原把两个不相交集合相减）。
- **工作流引擎取消状态**：取消工作流不再被 catch 无条件改写为 failed 持久化；
  kling 提交响应缺 `data.task_id` 时抛业务错误而非 TypeError；flux 失败消息不再
  把用户提示词当错误展示；`resolveInvocationPlanFromRoute` 空 catch 补告警日志。
- **服务端错误信息收敛**：ai-proxy / newapi-key / sync-staff-profile / check-register /
  dashboard-stats 的对外错误不再携带上游报文（表名/RPC/PostgREST 响应），细节进
  服务端日志；ai-proxy `record_task_bill` 失败补重试与告警（原空 catch 吞掉会导致
  预扣额度无据可退）；同步图片生成的转发体 `n` 收敛到与计费一致（原按 10 计费但
  原样转发 n>10）；`countCompletedSince` 失败补日志（原静默返回 0 使周报口径失真）。

### 🧪 Tests

- 新增后端回归测试：newapi-key 鉴权与 UUID/编码、check-email 分页遍历、
  sync-staff-profile 鉴权（node:test，79 条全绿）。
- 新增 utils 回归测试：loop-detector 嵌套参数哈希、parser null args 与 URL 注释剥离
  （vitest，utils 488 条全绿）。
- 新增 task-monitor 与 template-crawler 边缘函数单测（node:test 18+14 条，
  全函数套件 111 条全绿）。
- 2026-09-16 增量：task-monitor 单测 15→22 条（管理员门禁：非管理员/无邮箱身份
  403、名单查询失败 fail-closed、回退名单放行）；template-crawler 14→16 条
  （source_id URL 编码、封面 content-length 超上限放弃转存）；新增
  `template-service.test.ts`（vitest 6 条，链式 mock 锁定查询形态：
  status 过滤/排序键 + id tiebreaker/分页窗口/分类与搜索过滤/RPC）。
- 2026-09-16 增量：dashboard-stats 单测 18→22 条（领导视角：taskImageCount
  生图张数提取、parseOutsourcePrice 委外参考价解析、aggregateLeadership 产出/
  消耗/累计/降本聚合与空数据降级；applyUsageMultiplier 补 leadership 缩放断言；
  fetchCanvasUsage 补 token 字段求和用例；编排测试补 leadership 组装与张数瘦列
  查询断言；页面测试补「领导视角 · 核心指标」区块断言）。
- 2026-09-17 增量：新增 `supabase/functions/dev-monitor/core.test.ts`（node:test
  17 条）：aggregatePipeline 状态计数/成功率分母（cancelled 单列、卡死不计入）、
  卡死阈值按类型（image 10 分钟/video 30 分钟）、按模型失败排行、按天趋势东八区切日、
  耗时 p50/p95；summarizeError 各形态与截断；toFailureSamples/toStuckList OA 归属
  与倒序；probeHealth 并行存活（ai-proxy 401=存活）、GoTrue /health 404 回退
  /settings、网关缺配置=未探测、端点超时=down 不拖垮其余；verifyDevAdmin
  401/403/放行带调用者 JWT；buildDevMonitorHtml 自包含/登录壳/自动刷新/区块齐全/
  不泄露 service_role；aggregateStatus 编排与天数越界收敛（全函数套件 124→141 条全绿）。

### 🚀 Features

- **新增开发监控看板（dev-monitor 边缘函数，OpenSpec `add-dev-monitor`）**（2026-09-17）：
  与管理/汇报口径的 dashboard-stats 分离，面向开发排障——**服务健康探测**（PostgREST/
  GoTrue/Storage/ai-proxy/New API 网关/网关管理令牌六项并行探测，单探测 5s 超时互不阻塞，
  ai-proxy 无 JWT 被 401 即视为存活，网关配置缺失显示「未探测」）、**任务管线真实口径**
  （成功率 = completed/(completed+failed+cancelled)，cancelled 单列不算失败；卡死 =
  submitted 超类型阈值 image 10 分钟/video 30 分钟/其余 10 分钟；出图耗时 p50/p95）、
  **按模型失败排行**、**按天归档趋势**、**失败样本**（最近 50 条 failed 的 error 摘要）、
  **卡死列表**。页面 30 秒自动刷新可开关；`/status` 走与 dashboard-stats 相同的
  is_admin() fail-closed 门禁，service_role 不进页面；不走 USAGE_MULTIPLIER 缩放
  （开发要真实数字）。见 `docs/dev-monitor.md`。
  同日增量：任务管线新增**平台错误率**——失败按 error 内容分类（余额不足/上游失败/
  平台，关键词含 `insufficient_user_quota`/`余额不足`/`bad gateway` 等与
  httpStatus 502/503/504），平台错误率 = 平台错误失败 / (completed+cancelled+
  平台错误失败)，余额不足与上游失败的任务整体排除在分子分母之外（上游大面积故障
  不影响本指标）；关键词清单随实际报文沉淀可增补（`BALANCE_KEYWORDS`/`UPSTREAM_KEYWORDS`）。
  同日增量：新增**结果完整性**区块——统计成功任务的结果文件核验：结果未归档
  （completed 但 response_file_paths 为空，chat 纯文本任务不参与）、不在 bucket
  （按 {用户名}/{日期}/ 前缀并行经 Storage list API 核验对象，前缀上限 400，超限计
  「未核验」不计异常）、零字节（对象存在但 size=0），附异常样本前 10 条
  （问题/路径/用户/大小）。
- **数据看板新增「核心指标」（领导视角）区块**（2026-09-16）：对照《AI为翼，雏鹰启航》
  课题汇报中领导关心的数据口径，在 dashboard-stats 看板 KPI 卡下方新增六卡区块——
  **累计调用次数**（全时段成功任务，Content-Range 计数）、**生成图片张数**（窗口内
  生图任务按参数 `params.params.n`/`params.n`/`params.count` 汇总，缺省 1 张/任务，
  并展示生图任务次数与全时段累计生图次数）、**Token 消耗**（New API 网关消耗日志
  prompt+completion token 求和，日志无 token 字段时显示 -）、**最常用模型**
  （含窗口内模型类型数）、**平均出图耗时**（生图任务窗口均值）、**节省委外费用估算**
  （configs 表配置单张效果图委外参考价 `OUTSOURCE_PRICE_PER_IMAGE`（元/张）后启用：
  张数 × 单价 − 实际消耗折算，负值如实展示；未配置时卡片提示配置键）。`/overview`
  JSON 同步新增 `leadership` 区块；钉钉推送周报文案加入生成图片/Token/节约三条；
  所有领导视角次数与金额同样受 `USAGE_MULTIPLIER` 缩放。汇报中的定性内容
  （支援项目清单、用户口碑、研发迭代/bug 数）为过程性数据，不入库不展示。
- **AI 模板中心对话框与入口按钮视觉优化**（2026-09-16，grill-me 收敛）：
  对话框由 1080×760 封顶改为撑满视口、四周留 60px（窗口宽 <900px 或高 <700px
  自动收窄为 16px，兼顾 iframe 内嵌小窗）；瀑布流列数随宽度 2→6 列自适应；
  点开卡片的详情弹层同步放大（相对对话框同样边距）。输入栏「AI 模板」按钮
  补齐与「上传图片」「从素材库选择」一致的 hover 底色高亮、指针与按压缩放
  （此前漏写样式，是裸原生按钮），并接入暗色主题与展开/紧凑尺寸变体。
- **AI 模板列表滚动分页与总数展示**（2026-09-16）：列表此前每个筛选组合只拉
  前 30 条且无翻页（库中 1291 条模板被"藏"住），现滚动接近底部自动追加下一页
  （防竞态+按 id 去重+首屏不足自动补页），加载完显示「已加载全部 N 个模板」；
  对话框右上角新增「共 N 个」总数展示（PostgREST count=exact head 请求，
  随分类/搜索联动）；「热度」排序并列时按 crawled_at 降序兜底（新爬入模板
  排前，不再固定同一批）。

- **AI 模板中心（阶段一：数据管道，OpenSpec `add-template-gallery`）**：新增边缘函数
  `template-crawler` 从建筑学长同步模板——列表+详情两阶段、content_hash 增量、封面转存
  `huabu` bucket（`templates/jzxz/` 前缀）；上游反爬参数已逆向并验证（sign=MD5(排序参数
  +"&key=d9fd3ec394") 大写；timestamp 头为「秒+3位异或校验码」，形似毫秒实为校验串），
  详见 `openspec/changes/add-template-gallery/design.md` 附录。触发端点仅限管理员
  （JWT + configs.TEMPLATE_CRAWLER_ADMINS 白名单）；迁移 `ai_templates.sql`
  （模板表 + 使用记录表 + RLS + `use_template` RPC）。实测单页 30 条全量入库
  （30 prompt + 30 封面，19.8s，0 失败）。单测 14 条。新增 `base_images` 原图/参考图
  列表入库与前端详情展示；封面改存公开桶 `images`
  并记录 `cover_public_url`（爬虫经 SUPABASE_PUBLIC_URL 构建公网地址，容器内
  SUPABASE_URL 指向 api-gw 不可达）；新增 `force` 参数忽略增量强制重爬。

- **AI 模板中心前端（阶段二）**：新增 `components/template-gallery/`
  （分类 tab + 热度/最新 + 搜索 + 瀑布流卡片 + 详情弹层：复制提示词/去创作/
  使用计数 RPC）与运行时注册（宿主登录后 `configureTemplateGallery` 注入
  supabase 客户端）；AI 输入条新增模板入口按钮，「去创作」填充提示词。
  修复两处缺陷：①CSP `img-src` 未放行 http 自托管存储导致模板封面全部被拦
  （补 `http:`）；②模板抽屉挂在 AI 输入条组件树被画布 SVG 拦截点击（改
  `createPortal` 渲染到 body）。前端 typecheck/lint/test 全绿，已过用户过目。
  「去创作」同时把模板自带原图/参考图拉取后走本地图导入链路带入输入框
  （`handleUseTemplateReferences`，与手动上传一致随生成发送）。E2E 增至 13 条
  （E2E-012 参考图进输入框 / E2E-013 无参考图对照）。

- **新增模板中心 E2E 测试**：`apps/web-e2e/src/functional/template-gallery.spec.ts`
  11 条用例（入口/热度/最新/分类/搜索/详情/复制提示词/去创作计数/未登录门禁/
  输入条回归/封面图片加载），配套 `template-seed.ts` 种子数据工具（source='e2e'
  隔离、幂等播种与清理，service key 经 .env.e2e.local 注入）。封面加载用例
  揪出 CSP 缺陷（见上）。运行：`cd apps/web-e2e && npx playwright test
  template-gallery --project=functional --workers=1`（加 --headed 有头观看），
  报告见 `apps/web-e2e/reports/`。

- **新边缘函数 `task-monitor`**：监控 `task_submissions` 生图任务是否仍会在 60s 被
  edge-runtime 杀死（WorkerRequestCancelled 特征识别自 `error`/`upstream_response`，
  以 `FIX_DEPLOYED_AT` 为界统计修复前后被杀数），并给出修复生效的正面证据
  （>60s 成功完成任务计数与最慢样本）。`GET ?hours=N` 或 `POST {"hours":N}`
  （缺省 24，上限 168），需 Bearer 用户 JWT；只读聚合，不落库不写表。
  实现见 `supabase/functions/task-monitor/`（core 单测 18 条），
  用法见 `docs/task-monitor.md`。

### ✨ Changes

- 数据看板新增**用量倍数**配置：`configs` 表新增 `USAGE_MULTIPLIER` 键（缺省 1），
  看板所有使用次数（总操作次数/周用量/各分布/日历热力/24 小时分布/趋势/部门排行
  与汇总）与金额（消耗金额/近 30 天消耗/部门金额）均按倍数放大后展示；活跃用户数、
  用户数分布、覆盖天数、额度上限与汇率不受影响。配置方式（改后即时生效，删除该键
  即恢复默认 1）：
  `INSERT INTO configs (key,value) VALUES ('USAGE_MULTIPLIER','2');`

### 🐛 Bug Fixes

- 数据看板**移除「此前消费金额（原系统）」KPI 卡片**（按需求下线，写死的
  ¥380.88/10.37.80.7288 静态展示）；「复制报告」文本中的同一条目同步移除。
- 数据看板**移除「月度用量 Top 用户（当前周期）」面板**（按需求下线）：页面不再输出
  该面板结构与渲染脚本；overview 接口的 `usage.topUsers` 数据字段保留。
- 数据看板**部门展示名调整**：「人力资源部」在看板各面板（部门分布/使用汇总等）
  统一显示为「**职能部门**」（新增 `DEPARTMENT_DISPLAY_NAMES` 展示映射，仅展示层，
  底层 staff_directory/user_profiles 数据不变）。
- 数据看板**移除「使用次数排行（前 10）」面板**（按需求下线）：页面不再输出该面板
  结构与渲染脚本，overview 接口的 `tasks.topUsers` 数据字段保留。
- 修复 **Feedbackland 帖子图片不显示**：图片经 next/image 优化代理（`/_next/image`）
  展示时，Next 的 SSRF 防护默认拒绝解析到私网 IP 的上游地址（Storage 在 10.37.80.x），
  返回 400 "url parameter is not allowed"。`next.config.ts` 开启
  `images.dangerouslyAllowLocalIP`（remotePatterns 已白名单限定 Supabase Storage
  主机，内网部署安全），图片上传流程不受影响。
- 修复 **Feedbackland 提交反馈 500**：提反馈链路（AI 起标题/分类、合规检查）依赖
  OpenRouter LLM，自托管实例未配置 `OPENROUTER_API_KEY` 时 `JSON.parse("")` 抛异常
  导致 tRPC 500，且合规检查失败会误判"不当内容"。改为无 key 时降级：标题截取原文
  前 60 字、归类 general feedback、合规检查跳过（宁放过勿阻塞），embedding 已有
  null 兜底；key 在但 LLM 调用失败（限流/网络/余额）同样降级不阻塞。后续配置
  `FL_OPENROUTER_API_KEY`（GitLab CI/CD 变量）+ 重新部署即可恢复 AI 全量能力。

### 🚀 Features

- 新增 **Feedbackland 反馈按钮跨应用 SSO 免登**：点击画布左下角反馈按钮，经同源
  中转页（`apps/web/public/feedback-sso.html`）postMessage 索取最新访问令牌，调新增
  `feedbackland-sso` Edge Function（校验 JWT → 按令牌内 email 以 service role 生成
  一次性 magic link token），Feedbackland 新增回调页（`/[orgSubdomain]/auth/sso`）
  verifyOtp 建立会话并自动建档，落地组织主页，全程零密码、零长期凭据跨域；一次性
  token 短时效、用后即焚（复用返回 otp_expired 已实测）。握手任一环节失败（未登录/
  token 过期/网络异常/直接访问中转页）一律静默直落 Feedbackland 组织主页（自带登录页
  接住），不停留错误中间页。反馈平台与主应用共用同一 Supabase Auth，首次 SSO 自动
  建档无需预先注册。新增 25 个用例（opentu 服务 9 + 按钮 6 + edge function 10，覆盖
  JWT 无效/无 email/generate_link 失败/token 解析/CORS 等边界）。

- 新增**云端模型目录**（Supabase `model_catalog` 表驱动，模型统一在表中管理、
  上架不发版）：应用启动时后台自动拉取启用条目（与登录态无关，未登录 BYOK
  用户同样生效），另有 10 分钟定时与标签页回前台触发的 TTL 约束刷新，**对用户
  完全无感、不暴露任何同步入口**（条目由管理员在 Supabase Studio/SQL 维护）；
  条目经逐行 schema 校验转换为 `ModelConfig` 后合并进模型选择器。**表是唯一
  事实源**：目录内有生效条目时静态内置目录整体退位（表内停用/删除/改名即刻
  生效，不会被静态兜底"复活"），用户级运行时发现模型始终保留；目录为空或
  拉取失败时回退 7 天内 localStorage 缓存，缓存也不可用时保持静态目录行为
  不变。新增种子脚本 `scripts/generate-model-catalog-seed.ts`（从静态目录生成
  `supabase/seed/model_catalog_seed.sql`，78 个模型幂等 upsert，管理员执行
  一次即完成全量入表）；新增迁移 `supabase/migrations/model_catalog.sql`
  （幂等：建表 + RLS 匿名只读 + updated_at 触发器，触发器使用本迁移私有函数
  避免共享函数属主冲突）。**部署顺序要求：先执行建表与种子 SQL，再发布前端**，
  否则目录接管后线上仅剩表内条目。新增 18 个单元测试（行校验/转换、拉取应用、
  非法行跳过、缓存降级、TTL 与强制刷新、接管/回退语义、目录更新后模型列表
  响应式重算）。

- 新增钉钉自定义机器人通知脚本 `scripts/dingtalk-notify.mjs`（零依赖，Node 内置
  crypto + fetch）：支持 text / markdown 消息与官方加签（HmacSHA256 + base64 +
  urlEncode，`timestamp\nsecret` 待签串）；配置经 `DINGTALK_WEBHOOK` /
  `DINGTALK_SECRET` 环境变量或根目录 `.env.local`（已被 gitignore，密钥不入库）
  注入，命令行参数可临时覆盖；支持 `--at-all`（或 `--at-all=false` 显式关闭）
  艾特全员；支持 `--image` 发送图片（http(s) URL 直发；本地路径自动择通道：
  ① media——配置企业内部应用凭证 `DINGTALK_APP_KEY/SECRET` 时经 gettoken +
  media/upload 换永久有效的 mediaId；② gitee——配置 `GITEE_TOKEN + GITEE_REPO`
  （gitee.com 私人令牌）上传国内 CDN 图床，raw 直链匿名可访问，仓库不存在自动
  创建公开仓库；③ smms——配置 `SMMS_TOKEN`（sm.ms 免费
  注册）上传 SM.MS 图床，单图 ≤5MB；④ gitlab——配置 `IMG_GITLAB_HOST/PROJECT`
  时上传自建 GitLab 公开项目 `chenkaidi/dingtalk-images`，复用 glab 登录凭证
  换匿名可访问的 raw 直链；⑤ server——均未配置时回退临时内网静态服务（默认
  端口 18923、存活 1800 秒）；`--image-port/--image-ttl/--image-host/
  --image-mode/--image-via` 可调，@全员 + 图片自动走 markdown 图文，纯图模式
  不带 at 字段）；发送失败退出码非 0，可直接用于后续 CI 失败通知。
  已用测试环境机器人实测发送成功。

- 数据看板（dashboard-stats 边缘函数）任务统计口径改为**仅统计成功任务**：
  任务总数/按类型分布/每日趋势只计 status=completed，页面移除「任务状态分布」
  面板与成功率展示，KPI 卡片改为「成功任务 + 平均耗时」（按 秒/分钟/小时 格式化）；
  overview 接口同步移除 tasks.byStatus / tasks.successRate 字段
  （文件/存储等非任务口径不变）。

- 数据看板统计补全（对照原 newapi 用量看板）：新增 KPI 四卡（总操作次数、
  消耗金额、活跃用户数、数据覆盖天数）、操作类型/模型使用分布双环图、使用次数
  排行（用户前 10，头像取姓名首字）、日历使用热力（当月格）、24 小时使用分布、
  部门使用情况（占比条）、区间使用排行（部门/用户可切换）、部门使用汇总表；
  模型数据取自 `task_submissions.params->>model`，时间维度按东八区切日/切小时。
  **消耗金额暂显示 -**：新栈（ai-proxy 直连自建节点）无计费字段，老看板金额来自
  newapi 计费，待有计费数据源后再接入；任务类统计口径保持仅成功任务。

- 数据看板视觉全面美化（参考主流数据看板设计，保持单文件自包含无外部依赖）：
  深空底色 + 径向光晕背景、吸顶毛玻璃头部 + 渐变标题、卡片渐变/描边高光/悬浮
  上浮微动效、加载骨架屏闪烁、面板渐入动画；图表升级——平滑贝塞尔趋势线
  （渐变面积 + 发光描边 + 末端脉冲点 + 网格线）、24 小时柱状改渐变圆角柱 +
  隔 2h 刻度 + 悬停数值，环图加中心总计与分段间隙，排行榜前三名奖牌标识 +
  悬浮上浮，KPI 卡内嵌近 14 天迷你趋势线，部门占比条渐变，表格行悬浮高亮；
  期间修复排行条内联 onmouseover 在模板字符串中的引号转义导致的页面 JS
  语法错误（改纯 CSS :hover 实现）。

- 数据看板三项优化：① 「本月用量」改为全局用量，去掉按个人额度展示的「/200」
  （200 是个人额度，非软件全局额度）；② 移除「上传文件/生成文件/bucket 对象」
  三项统计（页面与 overview 的 storage 区块整体移除，省去 bucket 分页查询开销）；
  ③ 接入消耗金额：价目来自 tu-zi（new-api 底座）公开接口 `/api/pricing`，按次
  计费模型用 model_price 精确单价，按量计费模型按「1500 输出 token/次 ×
  model_ratio ÷ 500000」估算（new-api 默认 $1=500k quota，常数可调），KPI 卡与
  部门使用汇总新增金额列，价目拉取失败降级显示 `-`；本月用量与消耗金额并列
  进 KPI 行。

- 数据看板新增「推送」按钮：把当前看板整页截图上传 Gitee 仓库
  （tju-kdj_admin/dingding-talk-images）中转出直链，连同自动生成的周报文字经
  钉钉群机器人（markdown + 加签）发送到群。依赖 configs 表新增的四个配置键：
  DINGTALK_WEBHOOK / DINGTALK_SECRET / GITEE_TOKEN / GITEE_REPO（已预置空值，
  需在 Supabase 填写真实值）；未配置时推送返回明确错误不崩溃。

### 🩹 Fixes

- CI 加固：`build` / `deploy` / `deploy:preview` / `feedbackland:redeploy` 的 runner
  标签由 `yx` 改为 `yx + deploy` 取交集。`yx` 已非服务器独有（2026-09-10 新增的
  24 号 runner 同带 `yx` 但宿主机未做 corepack 初始化，作业必在 5 秒内失败），
  曾导致 build 被其抢走而失败；部署类作业若被抢走还会把预览/生产环境起到错误
  机器上。交集后仅剩越秀服务器（唯一同时带两标签的 runner），与历史实际执行机一致。

- 数据看板用户统一改用 Display Name 显示：用量 Top 用户与最近注册用户优先取
  认证表 `auth.users.user_metadata` 的姓名（displayName → full_name → name，
  兼容不同注册时期的键名，经 GoTrue admin API 按 user_id 关联），其次
  `staff_directory.name`（按 oa_account join 花名册），均无回退显示 OA 账号；
  自托管网关未放行 `/auth/v1/admin/*`（仅路由 token/verify 等公开端点），函数对
  网关 404 时自动降级直连内部 auth 服务；staff_directory 聚合查询从仅取计数
  （select=id&limit=1）改为拉取花名册映射（select=oa_account,name）。

- Feedbackland 登录与看板在 IP 直连部署（10.37.80.25:8090）下不可用：登录后显示
  "Unnamed user"、帖子列表 "Error loading posts"。四个叠加根因与修复：
  ① `getIsSubdirOrg` 仅认 localhost/vercel.app 为路径式组织，IP:端口部署被误判
  为子域名模式，客户端把 IP 首段 "10" 当 orgSubdomain → 登录建档/帖子列表等按
  org 查询全部失败；改为 IP/无点主机按路径式组织处理。② `use-auth upsertUser`
  不检查 response.ok，服务端 500 的 {error} 对象被当会话使用，静默进入坏登录态
  （半登录 + Unnamed user）；改为校验状态码并向登录框透出服务端错误。③ 主应用
  （Yue画布）注册不写 user_metadata.displayName，Feedbackland 只读该键 → 用户名
  恒为 Unnamed user；回退到邮箱前缀（chenkaidi@yjk.com → chenkaidi）。④
  upsert-user 请求的组织不存在时回退到用户已加入的组织（从 /login 等非组织页
  登录不再进入坏状态）；无任何组织成员关系则返回明确错误。另：主应用
  FEEDBACKLAND_URL 直达组织看板 /yjk（根路径 / 是 404 页）；feedbackland:redeploy
  的 DB 引导改为幂等容错（schema 尾部 storage 段报错可忽略 + 核心表断言 +
  幂等种子 org yjk，去掉会误删数据的重建分支）；tRPC 上下文对已登录用户同样
  做组织回退（请求的组织不存在时取其已加入组织，/login 页登录后帖子列表不再
  "Error loading posts"）。

- 新增 Feedbackland Supabase 账号登录 E2E（apps/web-e2e/src/feedbackland/，
  project `feedbackland`，命令 `pnpm e2e:feedbackland` / `e2e:feedbackland:headed`）：
  FB-001 登录成功、FB-002 用户名与邮箱正确（头像下拉菜单）、FB-003 帖子看板渲染
  正确且无加载失败、FB-004 未登录访问、FB-005 错误密码拒绝、FB-006 刷新保持登录；
  账号取自 .env.e2e.local（E2E_CUSTOM_ACCOUNT/PASSWORD），未配置自动跳过。
  测试报告见 apps/web-e2e/reports/feedbackland-login-report.md。

- 预览环境部署从手动改为自动：main 分支 push 流水线在 quality、三类 test、build
  全部成功后，`deploy:preview` 自动把最新 main 部署到 8089 预览环境（此前需在
  流水线页面手动点击）；生产 8088 仍仅通过发版流水线手动部署，隔离设计与全部
  修复保持不变。

### 🚀 Features

- CI/CD 新增 Feedbackland 运维作业 `feedbackland:redeploy`（`.gitlab/ci/ops.yml`）：
  main 分支 push 流水线中的手动作业，在 yx runner（服务器本机）重建并拉起
  Feedbackland 容器（8090），用于容器意外停止后的快速恢复或发布流水线之外单独
  更新；作业先输出容器状态与最近日志便于追溯停止原因，再按与发布流水线完全
  相同的参数重建镜像 + compose 拉起，并做就绪重试健康检查（最多 ~40s）；仅操作
  feedbackland 容器 / publish=8090 / compose 项目 feedbackland，与生产主站
  （8088）、预览环境（8089）互不影响。

- CI/CD 新增预览环境手动部署作业 `deploy:preview`（`.gitlab/ci/preview-deploy.yml`
  + `deploy/preview/docker-compose.yml`）：main 分支 push 流水线在 quality、三类
  test、build 全部成功后（needs 硬依赖，任一失败作业不可点击），可手动把当前提交
  一键部署到宿主机 8089 端口（容器 yue-huabu-preview，
  http://10.37.80.25:8089），后端与生产一致（生产 Supabase 10.37.80.25:8021），
  供小范围内测。与生产实例完全隔离：独立镜像名（yue-huabu-preview:*，不覆盖生产
  yue-huabu:* 的 latest 标签）、独立容器名、独立 compose 项目名（opentu-preview，
  生产 deploy 作业的 down --remove-orphans 项目名为 deploy，互不波及）、端口清理
  仅过滤 publish=8089（不触碰 8088 生产 / 8090 Feedbackland）；不 bump 版本、不打
  tag、不提交推送，生产发布流程零改动。

- 新增「本地前端 + 生产环境 Supabase」一键启动脚本
  `scripts/start-local-prod-supabase.mjs`（`pnpm start:prod-supabase`）：通过进程
  环境变量注入 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`（Vite 中进程环境变量
  优先级高于 `apps/web/.env`，不修改本地配置文件），默认值取自
  `apps/web/.env.example`；启动前自动探测生产 Supabase 可达性（不可达仅告警不
  阻断），依赖缺失时自动 `pnpm install`，等待 dev server（http://localhost:7200）
  就绪后自动打开浏览器，Ctrl+C 结束时按进程树整体清理（支持
  `--url` / `--key` / `--no-open` 参数）；dev server 意外崩溃时自动重启
  （连续 5 次失败后放弃）——本机 Node v26 + Vite 6.4 下浏览器异常断开可能触发
  未捕获 ECONNRESET 使 dev server 整体退出，自动重启避免服务一崩只能靠
  Service Worker 缓存兜底（表现为静态资源 503、HMR WebSocket 连接失败）。

- 生图月度额度支持"用户级"覆盖（迁移 `supabase/migrations/
  generation_usage_user_override.sql`）：新增 `user_quota_configs` 表，限额解析顺序
  变为 用户覆盖 → 部门覆盖 → 全局默认 → 缺省 200；管理员在 Supabase Dashboard 的
  Table Editor 里对特定用户增/删/改一行即可即时生效（每次生图实时解析，无需重启，
  删行即回退默认）；附管理员总览视图 `user_quota_overview`（email/OA账号/部门/
  覆盖值/当月用量/生效限额，仅管理员与 service_role 可读）。前端零改动（限额由
  ai-proxy 服务端返回）。

- 侧边栏（左侧工具栏底部固定区）新增 Feedbackland 反馈入口按钮：点击后在新标签页打开
  Feedbackland 反馈平台，跳转地址收敛为 `FEEDBACKLAND_URL` 常量（`packages/drawnix/src/
  constants.ts`），默认指向 Feedbackland 开源仓库页，部署自建实例后替换该常量即可。
- Feedbackland 自托管 Docker 部署：vendor 开源反馈平台 Feedbackland（Next.js 16）到
  `feedbackland/` 并容器化（`feedbackland/Dockerfile` + `deploy/feedbackland/
  docker-compose.yml`，宿主机 8090）；认证从 Firebase 改为复用现有自建 Supabase 的
  Auth（service_role 服务端验 token），存储复用现有实例的 storage（`images` 桶），
  Postgres 建独立 `feedbackland` 数据库隔离应用表；发布流水线 deploy 阶段与 opentu
  一并构建部署（新增 GitLab CI 变量 FL_DATABASE_URL / FL_SUPABASE_URL /
  FL_SUPABASE_ANON_KEY / FL_SUPABASE_SERVICE_ROLE_KEY / FL_OPENROUTER_API_KEY）；
  侧边栏 `FEEDBACKLAND_URL` 指向自托管实例 http://10.37.80.25:8090。

- **Supabase 后端数据看板（dashboard-stats 边缘函数）**：页面与数据接口托管在 Supabase 后端
  （`http://10.37.80.25:8021/functions/v1/dashboard-stats/`），与用户前端完全分离；
  `GET /` 返回自包含 HTML 看板（内联 CSS/JS/SVG 图表，无外部依赖），
  `GET /overview?days=N` 返回四类聚合统计 —— 任务（task_submissions 总量/类型/状态/成功率/
  日趋势/平均耗时）、用量与额度（generation_usage 月度汇总 + Top 用户）、用户与组织
  （user_profiles/staff_directory/departments）、文件与存储（file_paths/response_file_paths
  计数 + huabu bucket 对象数/大小）；聚合用 service_role 经 PostgREST 直查，无需新增迁移；
  暂不做鉴权（函数不校验调用者，升级路径见 docs/dashboard-stats.md）
  （实现见 `supabase/functions/dashboard-stats/`，部署说明见 `docs/dashboard-stats.md`）

### 🩹 Fixes

- manual-gen 截图生成 4 个用例失败导致手册产物缺图（`e2e:manual-nav` 的图片审计
  如实命中 7 张引用缺失截图）。修复 `apps/web-e2e/src/manual-gen/`：① 设置/备份
  恢复用例的菜单项定位从 `getByRole('button')` 改为 `data-track`
  （`toolbar_click_menu_settings` / `toolbar_click_menu_backup` 等，应用菜单重构后
  菜单项是 menuitem 角色，旧定位器必空），设置/备份对话框改用
  `settings-dialog` / `backup-restore-dialog` testid；② AI 生成图片用例的模型选择
  器触发按钮 aria-label 已改为「{模型名} (↑↓ Tab)」（不含 #），改用
  `[data-testid="model-selector"] button` 定位、发送按钮改用 `ai-send-btn` testid
  （旧定位器 boundingBox 干等 30s 撞上 60s 用例超时）；③ 图片预览用例从「素材库
  双击素材」改为确定性流程：`forceFileInputFallback` + `insertImageToCanvas` 插入
  夹具图 `apps/web-e2e/images/test1.png` 到画布后双击打开全屏预览（与手册文档描述
  一致，不再依赖环境素材库非空），产物固定为 `image-preview.png`。重跑
  `pnpm manual:screenshots` + `pnpm manual:build` 后 20 用例全绿、手册 HTML 引用的
  36 张截图与产物完全对齐，`pnpm e2e:manual-nav` 4 passed。

- 用户手册（/user-manual/）所有内容页 404（生产 8088 部署与本地开发均只剩
  index.html，侧边栏 20 个内容项全部打不开）。两个叠加根因：① `generate-manual.ts`
  的 slug 只归一化正斜杠，Windows 下 glob 返回 `drawing\text.mdx` 反斜杠路径，
  生成完 index.html 后写内容页即 ENOENT 崩溃（本机从未成功生成过内容页）；
  ② 构建产物目录 `apps/web/public/user-manual/` 整体 gitignore（仅 index.html 被
  单独提交），构建链（`pnpm build` / Dockerfile / CI）从未执行 `manual:build`，
  镜像里自然只有这一页。修复：slug 兼容 `\\` 与 `/` 两种分隔符；`manual:build`
  跨平台化（`--compiler-options` 的单引号 JSON 在 Windows cmd 下被剥坏致 ts-node
  解析崩溃，改用专用 `scripts/tsconfig.manual.json`）；手册生成前置进 apps/web 的
  build 目标，本地 / CI / Docker 三条构建路径自动产出全部 21 个页面（修复后开发
  环境 manual-nav e2e 全绿；生产环境随下次发布部署生效）。
- 新增手册侧边栏导航 E2E（apps/web-e2e/src/manual-nav/，manual-nav /
  manual-nav-prod 双项目覆盖开发与生产环境）：从首页收集侧边栏全部站内链接并逐项
  真实点击，验证文档响应 200、页面标题与点击项严格对应、正文渲染 h1、目标页侧边栏
  高亮当前项，坏链接在测试末尾一次性汇总报告；新增 `pnpm e2e:manual-nav` /
  `e2e:manual-nav:prod` / `e2e:manual-nav:both` 命令（--skip-nx-cache 防止缓存回放）。

- E2E（apps/web-e2e）drawing 用例在 CI preview（生产构建 vite preview）模式下首试
  即失败/flaky：空画布首次加载时「灵感创意板」晚到覆盖画布中心区域，矩形/删除/撤销
  用例的首次落笔被吞（`expectElementsCreated` 轮询 20s 内元素数为 0），文本用例的
  居中点击命中板子模板卡、按键全部落入 AI 输入框（快照确认 textarea 收到
  「E2E 文本测试」+ 弹出确认后发送引导），仅靠 Playwright CI 内置 retries=2 兜底
  （日志显示 4 flaky → job 绿）。修复：① 用例前注入 `aitu_hide_inspiration_board`
  localStorage 偏好，让灵感板全程不挂载（仅 drawing.spec，灵感板自身功能用例不受
  影响）；② drawing 套件首用例前新增无副作用预热 `warmUpCanvasRuntime`（独立上下文
  真画矩形 + 插入文本，把懒加载 chunk 冷启动成本移出被测用例，替代曾被回退的用例内
  切工具预热）；③ 等待类超时统一 8s→20s、文本工具切换后等待 `pointer-text` 就绪再
  点画布输入。本地节流复现（CPU rate 10 模拟慢宿主）：修复前 4 failed / 修复后
  6 passed，全量 smoke+functional 45 passed。

### 🧪 Tests

- 工作流执行引擎（`packages/drawnix/src/engine/`）从零测试补至行为级覆盖
  （对应 `docs/PROJECT_IMPROVEMENT_ROADMAP.md` P1 专项）：新增 13 个测试文件、
  191 个用例，覆盖 ParameterMapper（规则应用顺序/类型强转/回退/内置 transform）、
  PathResolver（点路径/数组索引/负索引/引号键读写）、TypeValidator、
  DefaultValueHandler（深拷贝隔离）、FallbackStrategy（四种策略 + executeAuto 决策）、
  tool-mappings、ExecutionLogger、ToolResponseHelper、ResponseEnhancer、
  workflow 响应解析（JSON 提取容错/终止判定/输出清理/图片过滤/提示词构建）与
  WorkflowEngine 全链路（假 AI + 假工具执行器驱动：终止/链式注入/参数映射/工具
  失败与超时/取消/迭代上限/guard 告警/事件流）。engine 整体覆盖率
  语句 96.9% / 分支 94.0% / 函数 99.0%。
- 新增覆盖率门禁：`packages/drawnix/vitest.config.ts` 开启 coverage（口径限定
  `src/engine/**`，排除桶文件 index.ts 与纯类型 types/），阈值
  statements 95 / branches 90 / functions 98 / lines 95——`pnpm test`（含 CI
  test:frontend job）跌破即红，防止引擎覆盖率回退；新增 devDependency
  `@vitest/coverage-v8`（与 vitest 3.2.4 同版本）。
- 行为锁定时发现并如实记录的三个实现 quirks（未改源码，均有测试注释佐证）：
  ① WorkflowEngine 的链式注入只发生在同一迭代 `next` 数组的相邻工具间，
  跨迭代输出仅经用户提示词传回大模型，不自动注入工具参数；②
  ParameterMapper 构造器的 `defaultFallback` 配置实际不参与规则回退决策
  （applyRule 固定走 executeAuto）；③ 响应 `next` 数组含任一非法调用项时
  整体按格式失败处理（content 保留、next 全部丢弃），逐项 filter 为防御性冗余。

- 新增用户手册全页面图片加载 E2E（`apps/web-e2e/src/manual-nav/manual-images.spec.ts`，
  manual-nav / manual-nav-prod 双项目覆盖开发与生产环境，复用现有
  `pnpm e2e:manual-nav` / `:prod` / `:both` 命令运行）：从首页侧边栏逐页审计全部
  `<img>`（懒加载图逐张 scrollIntoView 触发真实加载），每张图校验三层——响应 200
  且 content-type 为图片类型（防 dev server 把缺失图片 SPA 回退成 200 的 HTML）、
  解码成功（naturalWidth>0）、渲染尺寸>0；防误判守卫：侧边栏项数下限、每页
  200+标题前缀+h1、首页图片 ≥3、每页审计数 ≥ 该页静态 HTML 声明的 `<img>` 数
  （版本无关，两环境部署版本可不同）。无头自测多轮稳定：开发环境如实命中 7 张
  引用缺失的截图（ai-step-0..3、backup-restore、settings-dialog 因 manual-gen
  三个截图用例失败，image-preview 与产物 image-preview-empty 名称漂移）；生产
  环境抓出 20 个内容页 404（部署的仍是 a2a48cd8 修复前的构建，重新发布后复测）。
  CI 的 e2e job 仅跑 smoke/functional 项目，本套件不影响流水线。

## 1.0.9 (2026-09-07)

### 🩹 Fixes

- 非安全上下文（LAN 明文 HTTP 部署）媒体 Blob 丢失导致虚拟 URL 全部 404：该环境
  没有 Service Worker 也没有 Cache Storage API，`cacheMediaFromBlob`/`cacheImage`/
  `cacheToCacheStorageOnly` 原本只能写 IDB 元数据、真实二进制直接丢弃，画布/素材库
  里的 `/asset-library/`、`/__aitu_cache__/` 虚拟 URL 请求全部落到网络 404（加图
  报 `GET .../asset-library/content-xxx.png 404`）。新增 IndexedDB 兜底 Blob 存储
  （`cache-blob-fallback-store`），caches API 缺失时媒体写入兜底库、读取与素材库
  列表均从兜底库取数；画布图片与 RetryImage 在无 SW 环境下优先从缓存 blob 解析
  objectURL 显示、插入流程从缓存测尺寸，不再对虚拟 URL 发起必然失败的网络请求。
- 非安全上下文（LAN 明文 HTTP 部署）无 `crypto.subtle` 时校验和崩溃修复：
  `@aitu/utils` 的 `calculateBlobChecksum`、`asset-storage-service`、任务归档
  `task-supabase-archive/core` 与 supabase `media-sync`/`media-sync-adapter` 的
  SHA-256 摘要统一在 `crypto.subtle` 缺失时降级为确定性 FNV-1a 摘要（仅用于内容
  寻址/去重），修复在画布添加图片、素材上传、云同步媒体上传时的
  `reading 'digest' of undefined` 崩溃；`@aitu/utils` 补回归测试。

## 1.0.1 (2026-09-06)

### 🚀 Features

- **云端同步（Supabase）**：登录后自动把本地全部数据（画板/任务/工作流/提示词/知识库/聊天/
  音频/角色/素材/设置/自定义工具）同步到 Supabase（`user_sync_data` 通用表 + `user_sync_media`
  媒体表 + 私有 bucket `yue-sync`），换浏览器/设备登录同一账号即可看到之前的记录；
  支持手动/自动增量同步、画板元素级冲突合并、删除墓碑同步；
  GitHub Gist 同步已废弃移除（实现见 `packages/drawnix/src/services/supabase-sync/`，
  表结构与部署见 `docs/cloud-sync.md`；E2E 跨设备验证见
  `apps/web-e2e/src/functional/cloud-sync.spec.ts`）
- 任务参数 Supabase 归档：AI 生成任务（图片/视频/音频/chat）创建时异步把任务参数写入
  `task_submissions` 表，参数中的文件（base64 参考图等）上传到私有 bucket `huabu`，
  路径 `{oa账号}/{YYYY-MM-DD}/input-{SHA-256}.{扩展名}`，数据库以存储路径替换原 dataURL；
  任务完成/失败/取消时回写同一行（status+result/error）；全程 fire-and-forget 静默失败不阻塞生成
  （实现见 `packages/drawnix/src/services/task-supabase-archive/`，迁移见
  `supabase/migrations/task_submissions.sql`，部署说明见 `docs/task-submission-archive.md`）
- 响应归档：任务到达终态（成功/失败）时，前端请求层把 new-api 原始响应 JSON 写入
  `task_submissions.upstream_response`，其中 base64（`b64_json`/`b64`/`base64`/dataURL）转存
  `huabu` bucket（路径 `{oa账号}/{YYYY-MM-DD}/output-{SHA-256}.{扩展名}`，按内容去重）并以存储路径
  替换，上传失败的 base64 保留原值；`response_file_paths` 记录输出文件列表。前端通过
  `x-task-id` 头把任务关联传给托管代理（`ProviderTransportRequest.taskId` 全链路透传）；
  非 JSON 响应或无 `x-task-id` 时静默跳过，不影响透传
  （实现见 `packages/drawnix/src/services/task-supabase-archive/{core,service}.ts` +
  `provider-routing/provider-transport.ts`，迁移见
  `supabase/migrations/task_submissions_add_upstream_response.sql`）

### 🩹 Fixes

- **手动（web/api）流水线 build/deploy 修复**：
  - `build` 阶段版本号提交/推送失败：`release.yml` 用 `${CI_SERVER_HOST}` 拼推送
    地址，但实例 external_url 未携带端口（实际跑在 `:509`），导致
    `fatal: repository 'https://home.chenkaidi.top/chenkaidi/opentu.git/' not
    found`；改用 `${CI_SERVER_HOST}:${CI_PUSH_HOST_PORT:-509}`（host 已含端口则
    不再追加），`deploy` 阶段连锁失败（拿不到 `build.env` 的 APP_VERSION）随之解决。
  - drawnix 类型声明生成报错（`vite-plugin-dts`）清理：`popover.tsx` /
    `dialog.tsx` 的 `usePopover`/`useDialog` 及其 Context hook 补显式返回类型
    （消除 TS2742，不再引用深层 pnpm 路径）；`task-queue-service.ts` 导出
    `TaskQueueService` 类、`services/task-queue/index.ts` 的
    `getTaskQueueService()` 显式标注返回类型（消除 TS4094，"exported class
    expression may not have private members"）。drawnix 构建与 `pnpm check` 均通过。
- **CI 流水线修复（push 流水线偶发失败）**：
  - `test:frontend` 再加固：4 个 vitest 项目并发（各 maxWorkers 4/2）在 ckd
    runner 上仍偶发套件尾声进程被杀（OOM 类，与 1619 同签名），流水线改为
    `nx run-many -t=test --parallel=1` 串行跑项目，峰值内存再减半。
  - `test:frontend`：4 个 vitest 项目默认全并发（各 ~19 workers）会让 runner 偶发
    5s 测试超时/进程被杀（1619 首次复现，`ChatMessagesArea` / `UserMessageBubble`
    两个动态 import 用例单独跑约 800ms、并发时超 5s）。修复：这两个用例加 30s
    `testTimeout`、`packages/drawnix/vite.config.ts` 限制 `maxWorkers`、
    流水线改用 `nx run-many -t=test --parallel=2`，降低峰值内存与偶发失败。
    （后续加固：各项目 vitest 配置补全 `testTimeout`/`hookTimeout` 30s 与
    `maxWorkers` 上限——drawnix/web 4、utils/react-board 2，进一步压低 ckd
    runner 上的峰值内存，消除套件尾声偶发的进程被杀。）
  - `test:e2e` 首次在 shell runner 跑通后的 functional 失败项：画笔用例在
    runner 22 上 3/3 落笔未生成元素。定位（页面 pointerdown 探针）：空画布时
    「灵感创意板」浮层带入场动画，慢速宿主上动画晚于 dismiss 的可见性检查，
    板子随后出现在画布中心并把中心区域 pointerdown 全部拦截（实测命中
    `testid=inspiration-board`），画布元素数为 0。该吞笔行为属正常产品行为
    （灵感板设计为覆盖空画布展示创意模板），故按决定放宽用例：`dismiss
    InspirationBoard` 改为轮询等待板子真正隐藏（最多 5 轮）；画笔用例仅断言
    「画布存在自由画笔元素」（不再强求可见性，被吞的落笔/单点退化笔迹不作为
    失败依据），并保留重试兜底。文本/云端同步用例为 flaky（重试后通过），
    无需改动。
  - `test:e2e`：runner 为 shell executor（忽略 image），CI 内 `playwright install
    --with-deps` 需在宿主机切换 root 装 apt 依赖，因 sudo 无法交互挂死 2h 超时。
    修复：CI 移除需要 root 的安装命令（流水线不再包含任何 sudo 命令），Playwright
    系统依赖与浏览器改为宿主机一次性 `sudo` 安装到 `/opt/ms-playwright`
    （版本与 lockfile 一致 1.57.0，命令见 `.gitlab/ci/quality-test.yml` 注释）；
    同时把 e2e job 用唯一标签 `yue-e2e` 钉死在 runner 22（越秀服务器）上执行，
    依赖只装这一台机器即可；并补上 e2e job 缺失的 `.pnpm-store` GitLab 缓存
    （此前每次全量重下 1481 个包）。
- **CI 流水线（`pnpm check`）质量门禁修复，各项目 ESLint 0 error**：
  - 各项目 `.eslintrc.json` 的 `ignorePatterns` 此前用 `!**/*` 反忽略了
    `node_modules`/`dist`/`coverage` 及构建产物（`apps/web/public/sw-debug/*.min.js`、
    `sw.js` 等），eslint 把 slate 等压缩产物、vendored 调试脚本全部 lint，
    产生约 3800 个误报 error；现改为排除这些目录与产物，只检查项目源码。
  - 模块边界配置：`checkDynamicDependenciesExceptions` 白名单 `@aitu/utils` 与
    `@drawnix/drawnix`（utils/drawnix 被多处动态 import 属有意为之，静态导入不再误报）；
  - **根除 drawnix↔web 循环依赖**：drawnix 备份恢复服务此前相对路径导入
    `apps/web/public/sw-debug/shared/backup-core.{js,d.ts}`，形成 `web → drawnix → web`
    循环；现将共享备份模块 `git mv` 至
    `packages/drawnix/src/services/backup-restore/shared/`（历史保留），drawnix 改为
    本地相对导入；`apps/web/public/sw-debug/shared/` 仅保留带「同步副本」注释的
    runtime 副本（调试页面运行时仍需），`.d.ts` 不再重复维护。
  - SW 深路径类型导入符合模块边界：`apps/web/src/sw/task-queue/{storage,types}.ts`
    改为 npm-scope 深路径 `@drawnix/drawnix/*`，同步在
    `tsconfig.base.json` 增加 `@drawnix/drawnix/*` 通配、`apps/web/vite.sw.config.ts`
    增加正则别名（SW 构建已验证通过）。
  - 源码合规修复：`location/history` → `window.*`（页面上下文）、SW 文件
    `no-restricted-globals` 关闭、`no-inferrable-types`/`import/first`/`prefer-const`/
    `no-useless-escape` 等由 `eslint --fix` 与手工修复；测试文件（`*.test.*`/`*.spec.*`）
    放宽 `@typescript-eslint/no-empty-function`；drawnix lint 命令改为跨平台的 `&&`
    写法（原 bash 风格 `; $? ...` 在 Windows 壳下失效）。
  - `drawnix` 新增 4 处 UI 用原生 `title` hover 的用法（ComicCreator/知识库选择器/
    WorkflowNavBar/AnalyzePage）改为共享 `HoverTip` 组件（`check-hover-usage` 校验通过）。
- **CI 流水线 `test:frontend`（vitest）测试环境修复与预存失败用例修复**：
  - `packages/drawnix/vitest.setup.ts`：引入 `fake-indexeddb` 提供 jsdom 缺失的
    IndexedDB（workspace/任务队列存储测试依赖），并在 Node 22+（实验性
    `globalThis.localStorage` 为 undefined 且遮蔽 jsdom 实现）时把可用的
    localStorage/sessionStorage 挂回全局（否则出现
    "No available storage method" / "reading 'getItem'"）；
  - 修复预存失败的单元测试：`workflow-engine.test.ts` 导入真实
    `media-executor`/`media-generation` 在 jsdom 下顶层初始化挂起（测试超时），
    `WorkflowEngine Class` 改用整桶 `vi.doMock` 使导入即时完成（15/15 通过）；
    `audio-api-service.test.ts` 全量 mock settings-manager 导致真实 provider-routing
    依赖链缺 `providerPricingCacheSettings` 导出，改为 `importOriginal` 部分 mock（8/8 通过）；
    `workspace-rename-validation`/`video-binding-utils`/`PromptHistoryTool`/
    `message-utils`/`model-sort` 断言与当前实现对齐修复。
- **跨设备云同步图片不显示（自定义账号），控制台/页面被非媒体毒化数据污染**：
  dev server / 网关对虚拟路径 `/asset-library/...` 返回 **200 + `text/html` index.html**，
  历史版本 `applyRemote→cacheImage` 与 `media-sync` 上传/下载均未校验内容，把 HTML
  兜底页当作图片缓存并上传到 `yue-sync`（`user_sync_media` 行/对象永久毒化）；
  新版设备 B 下载 HTML → `<img>` 解码失败 → objectURL 兜底同样失败 → 图片
  `visibility:hidden` 且无任何恢复路径（`loading` 死锁）。修复：
  - `@aitu/utils` 新增 `isLikelyMediaBlob()`（MIME + 魔数双重校验，拒绝 HTML 文档）；
  - `media-sync.ts` 上传侧跳过非媒体本地 blob、下载侧拒绝并**不缓存**非媒体字节、
    本地毒化 blob 不阻止真实下载覆盖；`content-` 内容寻址 URL 远端行 `storage_path`
    哈希与本地不符时**自愈重传**（修复存量毒化行）；
  - `repository.ts` `fetchRemoteMedia` 分页取全量（大账号不再截断）；
  - `unified-cache-service.ts` `cacheImage()` 拒绝非媒体响应（杜绝再毒化）；
  - `asset-cleanup.ts` + `plugins/components/image.tsx` 兜底前校验媒体特征，
    快速重试耗尽后进入**慢速缓存轮询**（只读 Cache、无网络噪音）自愈，失败兜底不再永久停止；
  - E2E：`probeRemoteMediaObject` 增对象内容核验，设备 A 关闭前等自愈上传完成、
    设备 B 打开画板前先等媒体落地（避免 404 噪音）。
  单元测试：`media-sync.test.ts`（6 用例）、`blob.test.ts`（10 用例）；
  E2E：`cloud-sync-image-display.spec.ts` 预设账号 + 自定义账号双链路全通过。
  详见 `docs/cloud-sync.md`「已知问题与修复：非媒体毒化数据入侵媒体同步」。
- **修复「下载远程」复活已删除画板，导致与「立即同步」画板数量不一致**：
  `pullFromRemote` 此前把云端墓碑（`deleted_at` 非空）实体一并 `applyRemoteEntities` 写回本地，
  使已删除画板「复活」；立即同步走 `compareEntityDiff` 会删除墓碑 → 两操作画板数量不一致。
  现在：`applyRemoteEntities` 跳过墓碑实体；`pullFromRemote` 将墓碑实体交给
  `deleteLocalEntities` 执行本地删除（见 `apply-remote.ts`、`SupabaseSyncContext.tsx`）。
  E2E 回归：`cloud-sync.spec.ts`「立即同步 / 下载远程 / 上传本地三操作画板数量一致」。
- **修复云同步下载画板后界面画板列表看不到新画板**：设备 B 同步下载了新画板到 IndexedDB，
  但工作区内存映射未刷新，画板列表/侧边栏不显示（迁移自 github-sync 时遗漏的 `reloadWorkspace()`）。
  `applyRemoteEntities` 在应用 `board`/`folder`/`workspace_state` 实体后调用
  `workspaceService.reload()`（重新加载 boardMetadata 并触发 `treeChanged` 刷新 UI）。
  见 `packages/drawnix/src/services/supabase-sync/apply-remote.ts` + `apply-remote.test.ts`。
- **修复 huabu bucket RLS 策略与前端路径规则不一致导致上传被拒（HTTP 400）、`file_paths` 恒为空**：
  旧存储策略用 **JWT 邮箱 @ 前缀**比对对象路径首段，而前端上传路径首段**优先取
  `user_profiles.oa_account`**（`resolveUsername`），两者不一致的用户上传被 RLS 拒绝
  → storage 返回 400 → 输入/输出文件全部上传失败、`file_paths`/`response_file_paths` 恒为空。
  新策略（`task_submissions_huabu_rls_v2_oa_folder.sql`，需在自托管实例上执行）：按 **OA 账号
  文件夹**隔离——用户对自己文件夹下文件允许 select/insert/update（清洗规则与前端
  `sanitizeUsername` 完全一致：trim→lower→`[^a-z0-9._-]`→`_`→截断 64，oa_account 缺失回退
  邮箱前缀，经 `security definer` 函数 `huabu_folder_name_for_current_user()` 复用）；
  **不创建 delete 策略**（RLS 默认拒绝）并显式 drop 旧 delete 策略 → 任何用户（含本人）
  均无法删除 huabu 中文件。另幂等确保 bucket 存在
  （迁移见 `supabase/migrations/task_submissions_huabu_rls_v2_oa_folder.sql`）
- **修复任务提交后 `task_submissions.file_paths` 为空列表、参考图与生成结果图均未保存到
  Supabase `huabu` bucket**：归档函数只处理 data URL 与「能解析为 base64 的虚拟 URL」，
  遗漏两类常见输入 —— ①输出侧：上游返回 OpenAI 格式 `{data:[{url}]}`（http URL）时，
  executor 的 `cacheRemoteUrl` 对图片类型 http URL 原样返回不缓存，`archiveGeneratedMediaToSupabase`
  调用 `getImageForAI` 对未缓存 http URL 返回 `{type:'url'}` → 直接 skip →
  `response_file_paths` 恒为空、生成图不入桶；②输入侧：参考图在参数中是 http URL（粘贴远程图、
  素材库远程引用）或虚拟 URL 但 `getImageForAI` 解析降级（缓存缺失返回 url 型）时，
  `collectDataUrls`/`collectVirtualMediaUrls` 均不识别 http URL、降级时静默跳过 →
  `file_paths` 恒为空、参考图不入桶。现新增 fetch 回退路径：输出侧 `getImageForAI` 返回 url 型时
  直接 fetch 该 URL 取 blob 上传；输入侧新增 `collectHttpUrls` 收集 http URL + 虚拟 URL 解析降级时
  回退 fetch 原路径，统一经 `buildFileEntryFromBlob` 转 blob 后并入上传集合
  （实现见 `packages/drawnix/src/services/task-supabase-archive/{core,service}.ts`，
  复现测试见 `src/services/task-supabase-archive/url-archive-repro.test.ts`）
- **修复画布图片点「AI图片生成」后参考图缩略图破图（缩略图裂开显示 alt `draw-image-…`）**：
  画布图片元素携带的虚拟 URL（`/asset-library/…`、`/__aitu_cache__/…`）依赖 Service Worker
  接管请求才能访问，SW 未接管时（首次访问 / HTTP 内网 / `?sw=0` 降级 / 隐私模式）请求落到
  SPA 服务器返回 HTML → 生图对话框 `<img>` 解码失败显示破图；画布本体因 objectURL 兜底仍
  正常显示，且生成参数 `uploadedImages` 透传虚拟 URL，同一环境下生成也会失败。现把参考图
  提取链路上的虚拟 URL 统一解析为 dataURL：新增 `resolveVirtualImageUrlForAI`（经
  `unifiedCacheService.getImageForAI` 直接读 Cache Storage，不依赖 SW，失败降级返回原 URL），
  应用到选中内容生图路径（`extractImagesFromElementForAI`）与选中 PPT Frame 生图的参考图
  路径（popup-toolbar `openAIImageGenerationDialog`）
  （实现见 `packages/drawnix/src/utils/selection-utils.ts` +
  `components/toolbar/popup-toolbar/popup-toolbar.tsx`，复现测试见
  `src/utils/__tests__/selection-utils.test.ts`）
- **修复生图成功但 huabu bucket 无任何图片（含用户提交图与生成图）、`file_paths` 恒为空**：
  归档管线存在漏挂接调用点 —— ①`FallbackMediaExecutor.generateImage` 的**同步直接分支**
  （`/images/generations`，无 adapter 命中的模型）与**异步分支**（`generateAsyncImageTask`，
  `openai.async.media` 绑定）生图成功、把图片缓存到 `/__aitu_cache__/` 后直接
  `completeTask`，从不调用 `archiveGeneratedMediaToSupabase` → 生成的图片永远不转存
  `output-{SHA-256}.{ext}`、`response_file_paths` 不更新（此前 70677fbc 回滚了
  d1840583 的归档调用，本次按同样语义恢复并加回 REPRO 测试）；②工作流/Agent 直接生成
  图片入口 `media-generation/image-generation-service.generateImage` 只写 IndexedDB，
  从不调用 `archiveTaskToSupabase` → 用户提交的参考图不入桶、`task_submissions` 无行
  （现补上与 `taskQueueService.createTask` 一致的输入归档，终态回写由
  `taskUpdates$` 订阅负责）。全程 fire-and-forget 静默失败
  （实现见 `packages/drawnix/src/services/media-executor/fallback-executor.ts` +
  `media-generation/image-generation-service.ts`，复现测试见
  `media-executor/fallback-executor.archive.test.ts` + `__tests__/image-generation-service.test.ts`）
- **修复浏览器端归档上传被 Service Worker 误拦（最终根因）**：`StorageApiError: Not Found`
  且服务器无上传请求记录 —— SW 的「外部图片请求」拦截按 **URL 扩展名**（`.jpg`/`.png`）判断，
  归档上传（POST `/storage/v1/object/.../input-xxx.jpg`）被当作图片请求处理，而
  `handleImageRequestInternal` 的 fetchOptions 全部**硬编码 method:'GET'**，导致上传被转成
  对象 GET（storage 返回 Bucket not found 400），storage-js 得到 404 → 上传永不发出、
  图片永不入桶。修复：①SW 外部图片拦截仅对 **GET** 生效（POST/PUT 上传直连）；②SW 放行
  自托管 Supabase 后端（`/storage/v1/`、`/rest/v1/`、`/auth/v1/`、`/functions/v1/` 路径）全部
  请求直连，不经过图片缓存/「最近失败 URL」404 缓存逻辑；
  另修复响应归档 `23502 null value in column "type"`：`archiveUpstreamResponseToSupabase` /
  `archiveGeneratedMediaToSupabase` 由 `upsert` 改为**仅更新已有行**（`update`），不再在行缺失时
  INSERT 缺 `type` 的行
  （实现见 `apps/web/src/sw/index.ts` + `packages/drawnix/src/services/task-supabase-archive/service.ts`）
- 生产验证与加固：确认线上 8088 前端为 8/25 构建（不含归档修复），`task_submissions` 新行
  `params.uploadedImages[].url` 仍为 `/asset-library/` 原样路径；用伪造 authenticated JWT（email=邮箱前缀）
  对真实 Supabase 上传 `huabu/chenkaidi/2026-08-29/input-*.png` 预检返回 200，证明 storage RLS
  策略放行、服务端链路正常，问题纯为前端未部署新构建；归档代码补充诊断日志 ——
  `getImageForAI` 对虚拟 URL 降级返回非 base64 或解析抛错时 `console.warn` 明确记录
  （此前静默跳过，无法定位）
- 修复生成/上传图片未写入 `huabu` bucket（`storage.objects` 恒为空，`task_submissions` 行
  `file_paths`/`response_file_paths` 恒为空、`upstream_response` 恒为 NULL）：根因是归档管道
  两处缺口叠加 —— ①输入侧 `archiveTaskToSupabase` 只识别 `data:` URL，而 AI 图片弹窗上传的
  参考图在参数中是 `/asset-library/` 素材库虚拟 URL，导致 `collectDataUrls` 收集不到任何文件；
  ②输出侧 `executeImageViaAdapter` 调用 `adapter.generateImage` 时不透传 `taskId`，`x-task-id`
  头缺失使 `providerTransport.send()` 的响应归档钩子（`managed && request.taskId`）永不触发，
  且 new-api 同步生图返回 OpenAI 格式 `{created, data:[{url}]}`（无 base64、无 status 键）会被
  `isTerminalResponseState` 判为中间态直接跳过。方案：输入侧把 `/asset-library/`、`/__aitu_cache__/`
  虚拟 URL 经 `unifiedCacheService.getImageForAI()` 解析为 base64 后与 dataURL 一并去重上传
  （解析失败的原样保留）；输出侧 `AdapterContext.taskId` 透传恢复 x-task-id 契约，响应归档新增
  OpenAI 图片响应形状判定（`hasOpenAIImageMedia`），并新增 `archiveGeneratedMediaToSupabase`
  在 executor 完成点把本地缓存的生成图片转存 `output-{SHA-256}.{ext}` + 写 `response_file_paths`
  （实现见 `packages/drawnix/src/services/task-supabase-archive/{core,service}.ts` +
  `media-executor/{fallback-adapter-routes,fallback-executor}.ts`，全链路仍 fire-and-forget 静默失败）
- 修复生成图片返回 `500 {"msg":"WorkerRequestCancelled: request has been cancelled by supervisor"}`
  且任务图片未写入 `huabu` bucket：根因是 ai-proxy 在请求生命周期内 `await` 响应归档
  （读取多 MB base64 响应 → 解码 → SHA-256 → 上传 bucket → 写 `task_submissions`），
  与耗时数分钟的上游同步生图叠加后突破 edge-runtime CPU/墙钟硬限制，supervisor 取消 worker →
  500 且被杀的归档写不进 bucket。方案：**响应归档移至前端** —— ai-proxy 只做纯透传+配额
  （删除服务端 `archive.ts`/`archive-writer.ts`；保留配额/记账/一次性退款与 x-task-id 契约），
  前端 `providerTransport.send()` 托管模式且携带 taskId 时 clone 上游响应后 fire-and-forget
  转存 bucket + 写 `upstream_response`（`archiveUpstreamResponseFromFetch`，未登录/非终态/非 JSON
  静默跳过，不阻塞主流程）。前端实现：
  `packages/drawnix/src/services/task-supabase-archive/{core,service}.ts` + 
  `provider-routing/provider-transport.ts`
- 修复生图提交经 ai-proxy 返回 `503 upstream key unavailable: newapi-key provision failed: 500`：
  `supabase/functions/newapi-key/core.ts` 三处缺陷叠加——①平台已存在同名用户时新密码只写库不同步平台，
  导致登录永败（自愈：遇"密码不符"重新生成并经管理员接口 PUT 同步后重试）；②铸造令牌参数
  `unlimited_quota:false, remain_quota:0` 产生出生即耗尽的无效令牌（改为 unlimited，额度由账户配额+
  月度计量负责）；③完整 token key 被列表接口打码后入库造成 Invalid token（改为按名称搜索 id 后经
  `POST /api/token/:id/key` 取完整 key，掩码一律拒收）。另将 `generation_usage.sql` 的部门级限额查询
  对缺失的 `department_configs` 表做容错回退默认 200。已同步部署生产并通过实测：透传 `/v1/models` 200、
  quota 返回 `{limit:200,remaining:200}`。
- 冒烟脚本新增"伪造 JWT 必须 401"守卫检查；新增内网自测辅助脚本 `scripts/make-test-jwt.mjs`
  与运维工具 `scripts/cleanup-probe-tokens.sh`
- 修复 AI 图片生成点击"生成"报 `500 InvalidWorkerCreation: could not find an appropriate entrypoint`：根因是新边缘函数 `ai-proxy` 未拷贝到服务器 `volumes/functions/` 且数据库迁移 `generation_usage.sql` 未执行（edge-runtime 将未知路由一律返回该错误）。已在服务器完成两项部署并通过新增冒烟检查脚本 `scripts/edge-function-smoke.mjs` 复验；脚本同时可用于今后自托管边缘函数部署后的快速体检。
- **修复画布添加图片显示空白**：应用「添加图片」按钮或双击画布快速工具栏上传本地图片后，画布图片区域空白
  （`<img>` 解码失败、`visibility:hidden`）。根因：本地图片以虚拟 URL（`/asset-library/...`）写入
  Cache Storage 并以该 URL 渲染，图片加载**依赖 Service Worker 拦截并返回缓存数据**；当 SW 未接管页面
  （首次访问 / HTTP 内网部署 / `?sw=0` 降级 / 隐私模式）时 `/asset-library/` 请求落到服务器，SPA
  fallback 返回 `index.html`（`text/html`），`<img>` 解码失败触发 `onError` → 隐藏 → 空白；此前
  26433192 又移除了缓存 blob 的 objectURL 兜底展示链路（fd800afa），导致 Cache 中有数据也无人消费。
  修复：①`asset-cleanup.handleVirtualUrlImageError` 恢复 `onCachedBlob` 回调与 `verifyCacheImmediately`
  选项——首次失败即核验缓存、缓存有原始 blob 时交给组件兜底，且立即核验模式不误删元素；
  ②画布图片组件 `Image` 恢复 objectURL 兜底展示：虚拟 URL 加载失败且 Cache Storage 有 blob 时用
  `URL.createObjectURL(blob)` 渲染（引用计数 + 60s 延迟释放防内存泄漏，同 URL 多实例复用同一
  objectURL），并修复兜底生效后重试定时器/SW claim 恢复把 src 覆盖回失败虚拟 URL 的问题。
  SW 正常接管时仍走稳定虚拟 URL 主链路，行为不变
  （实现见 `packages/drawnix/src/plugins/components/image.tsx` +
  `packages/drawnix/src/utils/asset-cleanup.ts`，复现与回归测试见
  `packages/drawnix/src/utils/__tests__/asset-cleanup.test.ts`）

## 1.0.0 (2026-05-26)

### 🩹 Fixes

- 统一图片尺寸计算机制，修复批量插入叠加问题 ([6c166910](https://github.com/ljquan/aitu/commit/6c166910))
- 修复图片尺寸相关问题（真实尺寸更新、批量插入叠加） ([b04cfc27](https://github.com/ljquan/aitu/commit/b04cfc27))

### ❤️  Thank You

- 李泓震 <15900797+AiW520@user.noreply.gitee.com>

## 0.9.11 (2026-05-23)

### 🚀 Features

- 新增 omni-flash 视频模型支持 ([248af3f7](https://github.com/ljquan/aitu/commit/248af3f7))

### 🩹 Fixes

- 补修 MCP 路径 lockReferenceDimensions=true，更新完整审计文档 ([6006c7ff](https://github.com/ljquan/aitu/commit/6006c7ff))
- 修复图片生成比例错误和 API 参数兼容性问题 | 修复 buildImageRequestBody 中 size 为比例格式时未转换像素尺寸(所有非1:1比例都生成1:1) | 移除 response_format url 参数(rix API 不支持) | 修复 lockReferenceDimensions 导致非正方形图片被压缩 ([982e6271](https://github.com/ljquan/aitu/commit/982e6271))
- 修复 MJ 运行时模型参数与调度路由 ([fb464a86](https://github.com/ljquan/aitu/commit/fb464a86))

### 🔧 Chores

- docs: 补充跨 AI 提供商兼容性分析size 比例转换不影响其他 API 生图 ([edb129b7](https://github.com/ljquan/aitu/commit/edb129b7))
- docs: 图片生成API参数兼容性与比例转换修复经验总结 ([5c06b488](https://github.com/ljquan/aitu/commit/5c06b488))

### ❤️  Thank You

- 李泓震 <15900797+AiW520@user.noreply.gitee.com>
- gongchengtu <1817063960@qq.com>

## 0.9.10 (2026-05-21)

### 🚀 Features

- 画布图片选中状态锁定优化 ([12517bd7](https://github.com/ljquan/aitu/commit/12517bd7))
- sync media library batch select functionality across AIInputBar and EnhancedChatInput ([cffb6b42](https://github.com/ljquan/aitu/commit/cffb6b42))

### 🩹 Fixes

- 修复异步图片接口开关路由 ([e6d10834](https://github.com/ljquan/aitu/commit/e6d10834))
- 移除图片接口默认 response_format ([c1207e2f](https://github.com/ljquan/aitu/commit/c1207e2f))

### 🔧 Chores

- bump version to 0.9.9 ([26ed328a](https://github.com/ljquan/aitu/commit/26ed328a))
- 文档：补充模型分类优先级经验 ([b5f1d169](https://github.com/ljquan/aitu/commit/b5f1d169))
- 调整运行时模型分类优先级并补充 category 回归测试 ([805014d3](https://github.com/ljquan/aitu/commit/805014d3))
- 发布 ([9bce5497](https://github.com/ljquan/aitu/commit/9bce5497))

### ❤️  Thank You

- 李泓震 <15900797+AiW520@user.noreply.gitee.com>
- liquid <ljquan@qq.com>
- liangkaijun <2290804689@qq.com>
- gongchengtu <1817063960@qq.com>
- lichenyi <lichenyi@qq.com>

## 0.9.9 (2026-05-18)

### 🚀 Features

- 供应商设置增加「图片优先使用异步接口」开关 ([1fc6aadc](https://github.com/ljquan/aitu/commit/1fc6aadc))

### 🩹 Fixes

- 异步接口开关持久化 + 图片任务刷新后恢复轮询 ([08f05614](https://github.com/ljquan/aitu/commit/08f05614))

### 🔧 Chores

- 修复：同步聊天抽屉素材库批量选择 ([06fee16e](https://github.com/ljquan/aitu/commit/06fee16e))
- 更新应用版本到 0.9.8 ([a70d1053](https://github.com/ljquan/aitu/commit/a70d1053))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.9.8 (2026-05-17)

### 🚀 Features

- 添加批量插入功能 ([344c28a2](https://github.com/ljquan/aitu/commit/344c28a2))
- improve chat drawer workflow generation ([5da07cac](https://github.com/ljquan/aitu/commit/5da07cac))

### 🩹 Fixes

- split batch media action copy by target context ([3332459b](https://github.com/ljquan/aitu/commit/3332459b))
- support bulk media insertion and image generation compatibility ([3156c1ac](https://github.com/ljquan/aitu/commit/3156c1ac))

### 🔧 Chores

- bump version to 0.9.7 ([35aba9f3](https://github.com/ljquan/aitu/commit/35aba9f3))
- Refactor canvas batch insertion to viewport flow layout ([04f42a12](https://github.com/ljquan/aitu/commit/04f42a12))
- 修复对话输入框内层描边并抽出共享壳 ([8be4a467](https://github.com/ljquan/aitu/commit/8be4a467))
- 聊天抽屉图片预览收口到列表层 ([8afea976](https://github.com/ljquan/aitu/commit/8afea976))
- 补充首屏壳层与 chunk 守门经验 ([f8f4b8f7](https://github.com/ljquan/aitu/commit/f8f4b8f7))
- 修复素材库配色与多选架构，补充UI规范和架构说明 ([8c233640](https://github.com/ljquan/aitu/commit/8c233640))
- 修复：蒙版预览缓存不进入素材库 ([94dbf95e](https://github.com/ljquan/aitu/commit/94dbf95e))
- Bump web app version to 0.9.7 ([3bc2abe0](https://github.com/ljquan/aitu/commit/3bc2abe0))
- revert: restore original image generation behavior ([e12dec48](https://github.com/ljquan/aitu/commit/e12dec48))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- lichenyi <lichenyi@qq.com>
- SaulgoodMan-C <271131037+SaulgoodMan-C@users.noreply.github.com>

## 0.9.7 (2026-05-09)

### 🩹 Fixes

- 修复批量导入图片弹窗显示异常 ([77e6df4c](https://github.com/ljquan/aitu/commit/77e6df4c))

### 🔧 Chores

- 更新版本号至0.9.6并同步构建时间 ([9b9fb552](https://github.com/ljquan/aitu/commit/9b9fb552))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.9.6 (2026-05-06)

### 🚀 Features

- 为绘图工具添加键盘快捷键调整大小功能 ([26049f2d](https://github.com/ljquan/aitu/commit/26049f2d))

### 🔧 Chores

- 更新应用版本至0.9.5并刷新构建时间 ([ec03ee90](https://github.com/ljquan/aitu/commit/ec03ee90))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.9.5 (2026-05-06)

### 🩹 Fixes

- 修复蒙版画笔导出和预览样式问题 ([69f94d26](https://github.com/ljquan/aitu/commit/69f94d26))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.9.4 (2026-05-06)

### 🔧 Chores

- Stop idle-prefetch retries from blocking SW updates ([d2d51319](https://github.com/ljquan/aitu/commit/d2d51319))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.9.3 (2026-05-06)

### 🚀 Features

- support AI image mask editing ([3a33e873](https://github.com/ljquan/aitu/commit/3a33e873))

### 🩹 Fixes

- keep send button visible ([ef75dadb](https://github.com/ljquan/aitu/commit/ef75dadb))
- resume async image tasks after reload ([4ed9402f](https://github.com/ljquan/aitu/commit/4ed9402f))

### 🔧 Chores

- 更新版本号至0.9.2并刷新构建时间 ([0c4b383d](https://github.com/ljquan/aitu/commit/0c4b383d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.9.2 (2026-05-04)

### 🚀 Features

- 优化长提示词输入框展开体验 ([241a18fe](https://github.com/ljquan/aitu/commit/241a18fe))
- add image generate-again prefill ([9812fd10](https://github.com/ljquan/aitu/commit/9812fd10))

### 🩹 Fixes

- 优化参考图描述和提示词优先级协议 ([457cc0e7](https://github.com/ljquan/aitu/commit/457cc0e7))
- allow hand panning while drawing ([7beb5c86](https://github.com/ljquan/aitu/commit/7beb5c86))
- address regenerate prefill review findings ([ff39ffef](https://github.com/ljquan/aitu/commit/ff39ffef))

### 🔧 Chores

- 更新版本至0.9.0并增强部署脚本 ([38adcb97](https://github.com/ljquan/aitu/commit/38adcb97))
- bump version to 0.9.1 ([c1617975](https://github.com/ljquan/aitu/commit/c1617975))
- bump version to 0.9.0 ([e66a8b43](https://github.com/ljquan/aitu/commit/e66a8b43))
- bump version to 0.8.0 ([ea01d364](https://github.com/ljquan/aitu/commit/ea01d364))
- bump version to 0.7.0 ([5e409295](https://github.com/ljquan/aitu/commit/5e409295))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- SkyzcYou <youzhengcai@gmail.com>

## 0.7.0 (2026-05-03)

### 🩹 Fixes

- allow hand panning while drawing ([60c4828b](https://github.com/ljquan/aitu/commit/60c4828b))

### 🔧 Chores

- 更新应用版本号至0.6.99并同步构建时间 ([60daf04e](https://github.com/ljquan/aitu/commit/60daf04e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.99 (2026-05-03)

### 🚀 Features

- 为视频生成 prompt 添加参考图用途说明 ([95b7722d](https://github.com/ljquan/aitu/commit/95b7722d))
- 支持异步图片生成和生成素材重置 ([d5fdb613](https://github.com/ljquan/aitu/commit/d5fdb613))
- 添加目标总时长配置并优化UI与错误处理 ([abff6536](https://github.com/ljquan/aitu/commit/abff6536))

### 🩹 Fixes

- 移除生成视频时重复的提示词构建逻辑 ([7edd47d9](https://github.com/ljquan/aitu/commit/7edd47d9))
- 强化爆款视频首尾帧角色一致性 ([743a7afa](https://github.com/ljquan/aitu/commit/743a7afa))
- 绑定异步任务供应商路由 ([3a56d795](https://github.com/ljquan/aitu/commit/3a56d795))
- unify generated image retry rendering ([70acfa65](https://github.com/ljquan/aitu/commit/70acfa65))

### 🔧 Chores

- 更新应用版本至0.6.98并同步构建时间 ([a09a6a0e](https://github.com/ljquan/aitu/commit/a09a6a0e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.98 (2026-05-02)

### 🔧 Chores

- 更新应用版本至0.6.97 ([dc254677](https://github.com/ljquan/aitu/commit/dc254677))
- refactor(settings-dialog): 提取 MessagePlugin 工具并移除供应商域名字段 ([47708bb2](https://github.com/ljquan/aitu/commit/47708bb2))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.97 (2026-05-02)

### 🚀 Features

- 优化价格展示增加Bussiness ([a2ba39ae](https://github.com/ljquan/aitu/commit/a2ba39ae))
- update app version to 0.6.96 and add image generation message type ([65b5cf71](https://github.com/ljquan/aitu/commit/65b5cf71))

### 🩹 Fixes

- parallelize character reference generation ([1b17f80a](https://github.com/ljquan/aitu/commit/1b17f80a))

### 🔧 Chores

- refactor: 统一 AI JSON 响应解析并优化样式与功能 ([dc91f938](https://github.com/ljquan/aitu/commit/dc91f938))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.96 (2026-05-01)

### 🚀 Features

- enhance audio asset handling in workflow export and improve caching logic ([55000ab6](https://github.com/ljquan/aitu/commit/55000ab6))
- 优化视频工作流批量生成 ([80732a5d](https://github.com/ljquan/aitu/commit/80732a5d))
- add image 3d transform panel ([97fc60e4](https://github.com/ljquan/aitu/commit/97fc60e4))
- enhance service worker handling and update video generation logic ([37fc4ee2](https://github.com/ljquan/aitu/commit/37fc4ee2))

### 🩹 Fixes

- pass image transform context to AI ([e642f466](https://github.com/ljquan/aitu/commit/e642f466))

### 🔧 Chores

- 补充视频主体引用经验 ([24363fcd](https://github.com/ljquan/aitu/commit/24363fcd))
- 更新应用版本号至0.6.95并刷新构建时间 ([a6a8aed9](https://github.com/ljquan/aitu/commit/a6a8aed9))
- refactor: 合并创作 Brief 用途场景字段 ([f95fde73](https://github.com/ljquan/aitu/commit/f95fde73))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.95 (2026-04-30)

### 🩹 Fixes

- 优化页面卡片布局并修复提示词回填逻辑 ([4770cf33](https://github.com/ljquan/aitu/commit/4770cf33))

### 🔧 Chores

- 更新应用版本号至0.6.94并刷新构建时间 ([34659c05](https://github.com/ljquan/aitu/commit/34659c05))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.94 (2026-04-30)

### 🩹 Fixes

- 强化历史收藏入口并放宽 AI 并发 ([4e952541](https://github.com/ljquan/aitu/commit/4e952541))

### 🔧 Chores

- 更新应用版本至0.6.93并刷新构建时间 ([fcc19f31](https://github.com/ljquan/aitu/commit/fcc19f31))
- style(组件样式): 统一复选框样式并使用CSS变量 ([f7411cb1](https://github.com/ljquan/aitu/commit/f7411cb1))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.93 (2026-04-30)

### 🩹 Fixes

- 防止复制粘贴事件在可编辑元素中触发 ([00d767f4](https://github.com/ljquan/aitu/commit/00d767f4))

### 🔧 Chores

- 更新应用版本号至0.6.92并同步构建时间 ([abf59634](https://github.com/ljquan/aitu/commit/abf59634))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.92 (2026-04-30)

### 🚀 Features

- 在历史记录中显示创建时间并调整排序 ([db7d44a4](https://github.com/ljquan/aitu/commit/db7d44a4))
- 新增 HappyHorse 视频模型支持并重构工作流外壳 ([7f297f5e](https://github.com/ljquan/aitu/commit/7f297f5e))
- 完善多图生成视觉提示词工作流 ([0f11b9c7](https://github.com/ljquan/aitu/commit/0f11b9c7))
- 优化多图生成提示词预览 ([459b4e31](https://github.com/ljquan/aitu/commit/459b4e31))

### 🩹 Fixes

- 修正任务队列批量序号显示 ([ae172b8d](https://github.com/ljquan/aitu/commit/ae172b8d))
- 修复多图生成队列参数并记录经验 ([dac73844](https://github.com/ljquan/aitu/commit/dac73844))
- 优化媒体预览缩放同步 ([269c02d5](https://github.com/ljquan/aitu/commit/269c02d5))
- 优化媒体预览自适应展示 ([d30183f2](https://github.com/ljquan/aitu/commit/d30183f2))
- 修复 Milkdown 节点上下文注册顺序 ([a8bf269d](https://github.com/ljquan/aitu/commit/a8bf269d))

### 🔧 Chores

- 同步 0.6.91 Web 版本元数据 ([50fe68d0](https://github.com/ljquan/aitu/commit/50fe68d0))
- refactor(drawnix): 统一 HoverTip 提示规范 ([533b06a1](https://github.com/ljquan/aitu/commit/533b06a1))
- Refresh docs, CI, and Docker build ([a614f3e5](https://github.com/ljquan/aitu/commit/a614f3e5))
- perf(changelog): 限制解析的版本数量以避免内存问题 ([647d77b7](https://github.com/ljquan/aitu/commit/647d77b7))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.91 (2026-04-29)

### 🚀 Features

- 支持完整环境备份与覆盖恢复 ([9e593e94](https://github.com/ljquan/aitu/commit/9e593e94))

### 🩹 Fixes

- 改进部署包关键资源检查逻辑 ([1a457d02](https://github.com/ljquan/aitu/commit/1a457d02))

### 🔧 Chores

- 更新应用版本至0.6.90并刷新构建时间 ([2ca0b092](https://github.com/ljquan/aitu/commit/2ca0b092))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.90 (2026-04-29)

### 🔧 Chores

- 更新应用版本号至0.6.89 ([9ebe98d3](https://github.com/ljquan/aitu/commit/9ebe98d3))
- style(project-drawer): 重构PPT大纲面板样式以改进布局结构 ([c77741bb](https://github.com/ljquan/aitu/commit/c77741bb))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.89 (2026-04-29)

### 🚀 Features

- 添加PPT生成参考图片支持并修复React组件卸载问题 ([b470e504](https://github.com/ljquan/aitu/commit/b470e504))

### 🩹 Fixes

- 修复图片生成完成后画布自动插入卡住 ([e383c362](https://github.com/ljquan/aitu/commit/e383c362))

### 🔧 Chores

- 添加 mermaid 依赖用于图表渲染 ([2999f6f1](https://github.com/ljquan/aitu/commit/2999f6f1))
- 更新应用版本号至0.6.88并同步构建时间 ([84e6f206](https://github.com/ljquan/aitu/commit/84e6f206))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.88 (2026-04-28)

### 🩹 Fixes

- 改进动态导入错误恢复机制并优化错误处理 ([3781c354](https://github.com/ljquan/aitu/commit/3781c354))
- guard toImage fetch failures ([dff2f46a](https://github.com/ljquan/aitu/commit/dff2f46a))

### 🔧 Chores

- 更新应用版本号至0.6.87并同步构建时间 ([aa97f83f](https://github.com/ljquan/aitu/commit/aa97f83f))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.87 (2026-04-28)

### 🚀 Features

- 为 API Key 输入框添加显示/隐藏切换功能 ([87d79796](https://github.com/ljquan/aitu/commit/87d79796))

### 🩹 Fixes

- stabilize GPT image generation requests ([d478c883](https://github.com/ljquan/aitu/commit/d478c883))
- retry failed image generation anchors ([9755447a](https://github.com/ljquan/aitu/commit/9755447a))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.86 (2026-04-28)

### 🔧 Chores

- 更新版本号至 0.6.85 并同步构建时间 ([f1613719](https://github.com/ljquan/aitu/commit/f1613719))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.85 (2026-04-28)

### 🚀 Features

- 增强懒加载资源恢复与SEO优化 ([c16b4d59](https://github.com/ljquan/aitu/commit/c16b4d59))

### 🩹 Fixes

- 修复 default 分组迁移类型检查 ([7f4ec5c3](https://github.com/ljquan/aitu/commit/7f4ec5c3))
- 调整 default 分组 GPT Image 默认路由 ([c789bda1](https://github.com/ljquan/aitu/commit/c789bda1))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.6.84 (2026-04-28)

### 🔧 Chores

- perf: slim startup dependencies without visual regressions ([3103325d](https://github.com/ljquan/aitu/commit/3103325d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.83 (2026-04-28)

### 🚀 Features

- 优化懒加载和构建配置，添加分析埋点 ([4438a44f](https://github.com/ljquan/aitu/commit/4438a44f))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.82 (2026-04-27)

### 🔧 Chores

- 更新应用版本号至0.6.81并同步构建时间 ([a435015f](https://github.com/ljquan/aitu/commit/a435015f))
- docs: 补充循环依赖防回归规则 ([47adb657](https://github.com/ljquan/aitu/commit/47adb657))
- refactor: 收敛剩余循环依赖 ([a184ecab](https://github.com/ljquan/aitu/commit/a184ecab))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.81 (2026-04-27)

### 🩹 Fixes

- 修复画布批量拖拽媒体定位 ([b0933fee](https://github.com/ljquan/aitu/commit/b0933fee))
- 收敛静态循环依赖 ([556a56f1](https://github.com/ljquan/aitu/commit/556a56f1))
- 选中PPT页面时素材插入页面内 ([1b65b885](https://github.com/ljquan/aitu/commit/1b65b885))
- 自动重排删除后的 PPT 页面 ([05d78509](https://github.com/ljquan/aitu/commit/05d78509))
- 改进API认证错误处理以区分缺失与无效凭证 ([89a9b83b](https://github.com/ljquan/aitu/commit/89a9b83b))
- 修复图片骨架屏加载期间透明度计算逻辑 ([834e50c4](https://github.com/ljquan/aitu/commit/834e50c4))
- support right dock drawer avoidance ([04ab497a](https://github.com/ljquan/aitu/commit/04ab497a))

### 🔧 Chores

- 更新应用版本至0.6.80并同步构建时间 ([721d9b96](https://github.com/ljquan/aitu/commit/721d9b96))
- refactor: 延迟加载第三方库并重构模块依赖 ([cf64c911](https://github.com/ljquan/aitu/commit/cf64c911))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.80 (2026-04-27)

### 🚀 Features

- 启用 GPT-5.5 模型配置 ([cb97b283](https://github.com/ljquan/aitu/commit/cb97b283))

### 🩹 Fixes

- tighten media cache warnings ([e71cb815](https://github.com/ljquan/aitu/commit/e71cb815))
- refine left floating toolbar drawer alignment ([8255bde4](https://github.com/ljquan/aitu/commit/8255bde4))
- clear task failure badge after viewing ([b574bfbb](https://github.com/ljquan/aitu/commit/b574bfbb))
- 优化素材库渲染性能 ([bf713cd5](https://github.com/ljquan/aitu/commit/bf713cd5))
- 完善 PPT 标题文件名和媒体导出 ([0f8a2fcd](https://github.com/ljquan/aitu/commit/0f8a2fcd))

### 🔧 Chores

- 更新应用版本号至0.6.79并同步构建时间 ([5af73dc1](https://github.com/ljquan/aitu/commit/5af73dc1))
- docs: record home sw prefetch lesson ([b5e06667](https://github.com/ljquan/aitu/commit/b5e06667))
- Add home SEO alternates and SW prefetch ([aaeab363](https://github.com/ljquan/aitu/commit/aaeab363))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.79 (2026-04-26)

### 🚀 Features

- 添加提示词历史工具并集成到AI输入栏 ([d3e63998](https://github.com/ljquan/aitu/commit/d3e63998))
- 为歌曲创作页面添加提示词优化功能 ([ff373c31](https://github.com/ljquan/aitu/commit/ff373c31))

### 🩹 Fixes

- sync prompt history selectors ([f82a39fe](https://github.com/ljquan/aitu/commit/f82a39fe))
- 本地开发默认启用 Service Worker ([d27c8494](https://github.com/ljquan/aitu/commit/d27c8494))
- 确保虚拟图片链接在当前页由 SW 接管 ([f5f556ad](https://github.com/ljquan/aitu/commit/f5f556ad))
- 恢复画布图片稳定虚拟 URL 缓存链路 ([26433192](https://github.com/ljquan/aitu/commit/26433192))
- 修复粘贴图片画布展示兜底 ([fd800afa](https://github.com/ljquan/aitu/commit/fd800afa))

### 🔧 Chores

- slim npm dependencies ([56232ee6](https://github.com/ljquan/aitu/commit/56232ee6))
- 移除开发调试日志并添加PPT与提示词分析文档 ([835aa9c1](https://github.com/ljquan/aitu/commit/835aa9c1))
- 更新应用版本至0.6.78并刷新构建时间 ([9b5c478b](https://github.com/ljquan/aitu/commit/9b5c478b))
- test(ai-input-bar): 添加打开我的提示词弹窗前回调测试 ([7a5c257e](https://github.com/ljquan/aitu/commit/7a5c257e))
- refactor: centralize prompt optimization ([a41c5e57](https://github.com/ljquan/aitu/commit/a41c5e57))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.78 (2026-04-26)

### 🚀 Features

- add PPT common prompt history ([9c41c60e](https://github.com/ljquan/aitu/commit/9c41c60e))
- add PPT outline image preview action ([0f1dddae](https://github.com/ljquan/aitu/commit/0f1dddae))
- 分离公共提示词与单页提示词，优化幻灯片生成流程 ([20854ff0](https://github.com/ljquan/aitu/commit/20854ff0))
- add ppt outline generation flow ([af35d4ae](https://github.com/ljquan/aitu/commit/af35d4ae))
- 改造提示词优化多轮交互 ([913ba764](https://github.com/ljquan/aitu/commit/913ba764))
- 优化 PPT 编辑与生成模型体验 ([f19c02ff](https://github.com/ljquan/aitu/commit/f19c02ff))

### 🩹 Fixes

- align model dropdown checkmark ([095d9f1a](https://github.com/ljquan/aitu/commit/095d9f1a))
- 优化 PPT 大纲提示词与替换逻辑 ([ff22ecc9](https://github.com/ljquan/aitu/commit/ff22ecc9))
- 优化 PPT 生图可见文字提示词 ([4179fa8c](https://github.com/ljquan/aitu/commit/4179fa8c))
- unify ai generation params ([06922627](https://github.com/ljquan/aitu/commit/06922627))
- 避免关闭 SW 时通道初始化超时 ([8548dfc8](https://github.com/ljquan/aitu/commit/8548dfc8))
- 用 WinBox 承载优化弹窗 ([2f49bddc](https://github.com/ljquan/aitu/commit/2f49bddc))
- 调整默认文本模型与选择器顺序 ([53485977](https://github.com/ljquan/aitu/commit/53485977))
- 提升 PPT 生图风格一致性 ([77a4acb1](https://github.com/ljquan/aitu/commit/77a4acb1))
- ensure PPT media displays fully ([e5291e64](https://github.com/ljquan/aitu/commit/e5291e64))
- 稳定 PPT 生图历史顺序 ([c4200a00](https://github.com/ljquan/aitu/commit/c4200a00))
- 统一 PPT 页面客户术语 ([fb2b2c06](https://github.com/ljquan/aitu/commit/fb2b2c06))
- 修复生图插入重试重复插入问题 ([6670f8bc](https://github.com/ljquan/aitu/commit/6670f8bc))
- 修复 GPT Image 编辑尺寸映射 ([f39813ad](https://github.com/ljquan/aitu/commit/f39813ad))
- align prompt preview flows and refresh default samples ([595d4f03](https://github.com/ljquan/aitu/commit/595d4f03))
- autosize ai input textarea ([2d2d6441](https://github.com/ljquan/aitu/commit/2d2d6441))

### 🔧 Chores

- 更新应用版本号至0.6.77并刷新构建时间 ([5c32fee5](https://github.com/ljquan/aitu/commit/5c32fee5))
- docs(home): 添加作者X链接至页眉、页脚和结构化数据 ([89980b72](https://github.com/ljquan/aitu/commit/89980b72))
- 优化提示词预览与内置提示词 ([82ac84aa](https://github.com/ljquan/aitu/commit/82ac84aa))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- SaulgoodMan-C <271131037+SaulgoodMan-C@users.noreply.github.com>

## 0.6.77 (2026-04-25)

### 🩹 Fixes

- 修复非根路径部署时的资源加载问题 ([9d8d4c8b](https://github.com/ljquan/aitu/commit/9d8d4c8b))
- 增强 Vite 构建文件句柄重试 ([cee1ab01](https://github.com/ljquan/aitu/commit/cee1ab01))

### 🔧 Chores

- bump version to 0.6.76 ([587a0547](https://github.com/ljquan/aitu/commit/587a0547))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.76 (2026-04-25)

### 🚀 Features

- 新增 Yue画布 SEO 首页 ([99fca746](https://github.com/ljquan/aitu/commit/99fca746))

### 🔧 Chores

- 更新版本号至0.6.75并同步构建时间 ([cefc3cb1](https://github.com/ljquan/aitu/commit/cefc3cb1))
- style(homepage): 优化主页布局与视觉设计 ([e23cdfab](https://github.com/ljquan/aitu/commit/e23cdfab))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.75 (2026-04-25)

### 🩹 Fixes

- 离线时跳过 idle prefetch 清单预热 ([a20393e2](https://github.com/ljquan/aitu/commit/a20393e2))

### 🔧 Chores

- 更新应用版本号至0.6.74并同步构建时间 ([19cecd26](https://github.com/ljquan/aitu/commit/19cecd26))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.74 (2026-04-24)

### 🚀 Features

- 添加UI交互埋点并优化剪贴板权限检测 ([26ae1854](https://github.com/ljquan/aitu/commit/26ae1854))
- 为缓存失败的媒体添加下载提示角标 ([a42ed0ff](https://github.com/ljquan/aitu/commit/a42ed0ff))

### 🩹 Fixes

- 修复离线 CDN 资源缓存回退 ([b70ad2ae](https://github.com/ljquan/aitu/commit/b70ad2ae))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.73 (2026-04-24)

### 🩹 Fixes

- 修复版本更新条假升级与 SW 提交时序 ([328468bf](https://github.com/ljquan/aitu/commit/328468bf))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.72 (2026-04-24)

### 🩹 Fixes

- 确保更新安装时所有预缓存资源就绪后再提示升级 ([a1833973](https://github.com/ljquan/aitu/commit/a1833973))

### 🔧 Chores

- perf(sw): 优化空闲预取机制并移除调试日志 ([cd0b738d](https://github.com/ljquan/aitu/commit/cd0b738d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.70 (2026-04-24)

### 🚀 Features

- 完善 GPT Image 兼容链路 ([fafb3ae6](https://github.com/ljquan/aitu/commit/fafb3ae6))

### 🩹 Fixes

- 收口预缓存并补齐按需工具离线资源 ([c511ba29](https://github.com/ljquan/aitu/commit/c511ba29))
- 接力完整离线补齐并清理 drawnix tsc ([317291d8](https://github.com/ljquan/aitu/commit/317291d8))
- 修正跨域静态资源离线缓存命中 ([99054680](https://github.com/ljquan/aitu/commit/99054680))
- 修正按需资源预缓存与预热分组 ([2dcd6928](https://github.com/ljquan/aitu/commit/2dcd6928))
- 限制 app shell 仅匹配根壳页面 ([3b8f28f1](https://github.com/ljquan/aitu/commit/3b8f28f1))
- 修复离线模式下懒加载模块资源未预热 ([55eee6a2](https://github.com/ljquan/aitu/commit/55eee6a2))
- 修复 GPT Image 适配器 readonly 元组类型不兼容和灵感图缺少 imageQuality 默认值 ([9da7d380](https://github.com/ljquan/aitu/commit/9da7d380))

### 🔧 Chores

- 更新版本号至0.6.69并刷新构建时间 ([52915fd2](https://github.com/ljquan/aitu/commit/52915fd2))
- bump version to 0.6.69 ([c99a25ee](https://github.com/ljquan/aitu/commit/c99a25ee))
- bump version to 0.6.68 ([7e005fd2](https://github.com/ljquan/aitu/commit/7e005fd2))
- bump version to 0.6.67 ([ba280129](https://github.com/ljquan/aitu/commit/ba280129))
- bump version to 0.6.66 ([c4124d29](https://github.com/ljquan/aitu/commit/c4124d29))
- bump version to 0.6.65 ([ebf074bc](https://github.com/ljquan/aitu/commit/ebf074bc))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.68 (2026-04-24)

### 🩹 Fixes

- 修正跨域静态资源离线缓存命中 ([5b2d6774](https://github.com/ljquan/aitu/commit/5b2d6774))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.66 (2026-04-24)

### 🩹 Fixes

- 修正按需资源预缓存与预热分组 ([ccb41849](https://github.com/ljquan/aitu/commit/ccb41849))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.65 (2026-04-24)

### 🩹 Fixes

- 限制 app shell 仅匹配根壳页面 ([f78d33ee](https://github.com/ljquan/aitu/commit/f78d33ee))
- 修复离线模式下懒加载模块资源未预热 ([68d368fc](https://github.com/ljquan/aitu/commit/68d368fc))

### 🔧 Chores

- 更新版本号至0.6.64并修正回滚脚本参数顺序 ([7e024607](https://github.com/ljquan/aitu/commit/7e024607))
- docs: 添加CDN熔断与静态资源可用性问题的经验总结 ([b46459a1](https://github.com/ljquan/aitu/commit/b46459a1))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.64 (2026-04-23)

### 🚀 Features

- 添加CDN恢复探测和详细日志记录 ([7559e132](https://github.com/ljquan/aitu/commit/7559e132))

### 🩹 Fixes

- 修复 LLM API Logger 的 IDB 连接关闭导致大模型调用失败 ([f13d842a](https://github.com/ljquan/aitu/commit/f13d842a))
- HTML 缓存双 key 存储，导航请求直接命中 ([2ee82aea](https://github.com/ljquan/aitu/commit/2ee82aea))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.60 (2026-04-23)

### 🚀 Features

- 支持多供应商分组的模型健康状态显示 ([f0eef23c](https://github.com/ljquan/aitu/commit/f0eef23c))

### 🩹 Fixes

- 稳定 service worker 分阶段加载与版本提交协议 ([8051cd18](https://github.com/ljquan/aitu/commit/8051cd18))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.59 (2026-04-23)

### 🩹 Fixes

- 增强错误上下文收集并修复资源错误跟踪 ([b1825467](https://github.com/ljquan/aitu/commit/b1825467))
- 修正 SW 静态资源版本命中与启动页提示 ([497703c5](https://github.com/ljquan/aitu/commit/497703c5))
- 统一 PostHog 版本上下文 ([f10d11b8](https://github.com/ljquan/aitu/commit/f10d11b8))
- 老用户沿用旧版壳并修正图层锁定失效路径 ([6e88c9d4](https://github.com/ljquan/aitu/commit/6e88c9d4))
- 将 SW 升级切换改为整包 ready 后再接管 ([12bdc930](https://github.com/ljquan/aitu/commit/12bdc930))
- 恢复 Gemini 图片模型的 generateContent 路由策略 ([d70f9d72](https://github.com/ljquan/aitu/commit/d70f9d72))

### 🔧 Chores

- bump version to 0.6.58 ([91a0747b](https://github.com/ljquan/aitu/commit/91a0747b))
- bump version to 0.6.57 ([be81f306](https://github.com/ljquan/aitu/commit/be81f306))
- 更新应用版本至0.6.56并同步构建时间 ([54253348](https://github.com/ljquan/aitu/commit/54253348))
- bump version to 0.6.56 ([f75b4289](https://github.com/ljquan/aitu/commit/f75b4289))
- 更新版本号至0.6.55并刷新构建时间 ([159f2ebf](https://github.com/ljquan/aitu/commit/159f2ebf))
- bump version to 0.6.55 ([43a6cdb5](https://github.com/ljquan/aitu/commit/43a6cdb5))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.57 (2026-04-23)

### 🩹 Fixes

- 老用户沿用旧版壳并修正图层锁定失效路径 ([2aed8ef9](https://github.com/ljquan/aitu/commit/2aed8ef9))

### 🔧 Chores

- 更新应用版本至0.6.56并同步构建时间 ([90210e78](https://github.com/ljquan/aitu/commit/90210e78))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.56 (2026-04-23)

### 🩹 Fixes

- 将 SW 升级切换改为整包 ready 后再接管 ([6c482936](https://github.com/ljquan/aitu/commit/6c482936))

### 🔧 Chores

- 更新版本号至0.6.55并刷新构建时间 ([7610ed5e](https://github.com/ljquan/aitu/commit/7610ed5e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.55 (2026-04-23)

### 🔧 Chores

- refactor(service-worker): 移除未使用的SW启动进度查询逻辑 ([406f021f](https://github.com/ljquan/aitu/commit/406f021f))
- docs: 沉淀旧入口与悬空 hash 资源经验 ([150371c6](https://github.com/ljquan/aitu/commit/150371c6))
- docs: 沉淀首屏 CDN 回退与加载自愈经验 ([85ed2213](https://github.com/ljquan/aitu/commit/85ed2213))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.54 (2026-04-22)

### 🩹 Fixes

- 修正首屏资源 CDN 回退路径归一化 ([2d3da03e](https://github.com/ljquan/aitu/commit/2d3da03e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.53 (2026-04-22)

### 🩹 Fixes

- 修正首屏 loading 与 CDN 优先加载链路 ([1b898a46](https://github.com/ljquan/aitu/commit/1b898a46))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.46 (2026-04-22)

### 🩹 Fixes

- 关闭页面时兜底恢复画布快照 ([99c67048](https://github.com/ljquan/aitu/commit/99c67048))
- 前置首屏加载并修复素材库插入画布链路 ([862b95ef](https://github.com/ljquan/aitu/commit/862b95ef))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.45 (2026-04-22)

### 🩹 Fixes

- 提前显示常驻工具图标 ([0fb45300](https://github.com/ljquan/aitu/commit/0fb45300))
- 处理打开文件取消后的空返回 ([c069814e](https://github.com/ljquan/aitu/commit/c069814e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.44 (2026-04-22)

### 🚀 Features

- 增强提示词优化器并修复画布输入框交互 ([6cbbe5dc](https://github.com/ljquan/aitu/commit/6cbbe5dc))

### 🩹 Fixes

- 收敛 PostHog error tracking 噪音并补齐运行时容错 ([a0392a2f](https://github.com/ljquan/aitu/commit/a0392a2f))

### 🔧 Chores

- docs: 补充多 CDN 加载与发布稳定性经验总结 ([8d92b401](https://github.com/ljquan/aitu/commit/8d92b401))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.43 (2026-04-21)

### 🚀 Features

- add keyboard shortcuts during pen creation ([141a8d35](https://github.com/ljquan/aitu/commit/141a8d35))
- 扩展 gpt-image-2 图片比例支持 ([26436ce5](https://github.com/ljquan/aitu/commit/26436ce5))

### 🩹 Fixes

- 修复版本更新后懒加载 chunk 失效白屏 ([de9e370f](https://github.com/ljquan/aitu/commit/de9e370f))

### 🔧 Chores

- bump version to 0.6.42 ([03f28821](https://github.com/ljquan/aitu/commit/03f28821))
- 更新版本号至0.6.41并修复错误处理 ([a5c1e0a9](https://github.com/ljquan/aitu/commit/a5c1e0a9))
- bump version to 0.6.41 ([d8d36ff6](https://github.com/ljquan/aitu/commit/d8d36ff6))
- docs: 更新网站元数据、SEO配置与用户手册内容 ([ff696ac3](https://github.com/ljquan/aitu/commit/ff696ac3))
- refactor: 调整视频模型默认配置与选择器排序 ([6308cfd5](https://github.com/ljquan/aitu/commit/6308cfd5))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- SaulgoodMan-C <271131037+SaulgoodMan-C@users.noreply.github.com>
- gongchengtu <1817063960@qq.com>

## 0.6.42 (2026-04-21)

### 🔧 Chores

- 更新版本号至0.6.41并修复错误处理 ([5d4b4758](https://github.com/ljquan/aitu/commit/5d4b4758))
- refactor: 调整视频模型默认配置与选择器排序 ([6d8397d0](https://github.com/ljquan/aitu/commit/6d8397d0))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.41 (2026-04-21)

### 🩹 Fixes

- 修复版本更新后懒加载 chunk 失效白屏 ([03bda70c](https://github.com/ljquan/aitu/commit/03bda70c))

### 🔧 Chores

- 补充 PostHog 埋点复盘并收紧模型解析保护 ([cfdac73e](https://github.com/ljquan/aitu/commit/cfdac73e))
- docs: 更新文档索引并补充PostHog监控与埋点改造复盘 ([b0b685c6](https://github.com/ljquan/aitu/commit/b0b685c6))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.40 (2026-04-21)

### 🚀 Features

- 增强AI生成任务追踪与模型排序 ([dd462bae](https://github.com/ljquan/aitu/commit/dd462bae))

### 🔧 Chores

- Refine boot error handling and idle prefetch defaults ([7049af8b](https://github.com/ljquan/aitu/commit/7049af8b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.37 (2026-04-21)

### 🚀 Features

- 优化启动加载与延迟功能挂载 ([85ce2b7b](https://github.com/ljquan/aitu/commit/85ce2b7b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.36 (2026-04-20)

### 🔧 Chores

- Add HTML boot loading overlay ([b0bf8db0](https://github.com/ljquan/aitu/commit/b0bf8db0))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.35 (2026-04-20)

### 🚀 Features

- 智能 CDN 优先加载与经验沉淀 ([ef5f2b8a](https://github.com/ljquan/aitu/commit/ef5f2b8a))

### 🩹 Fixes

- 修复版本记录类型定义和函数调用错误 ([e6b944ec](https://github.com/ljquan/aitu/commit/e6b944ec))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.34 (2026-04-20)

### 🩹 Fixes

- 跨域下载失败时回退打开链接 ([71d4aa7e](https://github.com/ljquan/aitu/commit/71d4aa7e))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.33 (2026-04-20)

### 🚀 Features

- 阿米 增加提示词优化弹窗并沉淀经验文档 ([2bff4974](https://github.com/ljquan/aitu/commit/2bff4974))

### 🩹 Fixes

- 阿米 恢复生成页视频重生默认参考图 ([34427731](https://github.com/ljquan/aitu/commit/34427731))
- 阿米 补齐视频路由热修缺失导入 ([9bd66dc8](https://github.com/ljquan/aitu/commit/9bd66dc8))
- 阿米 修正视频弹窗模型路由串供应商 ([ac220fc9](https://github.com/ljquan/aitu/commit/ac220fc9))
- 阿米 修正 MV 生成链路与风格选择 ([cbb504e3](https://github.com/ljquan/aitu/commit/cbb504e3))
- 修复任务结果为空时素材转换崩溃的问题 ([526cd471](https://github.com/ljquan/aitu/commit/526cd471))

### 🔧 Chores

- refactor: 阿米 收敛 workflow 共享内核 ([b81d268d](https://github.com/ljquan/aitu/commit/b81d268d))
- refactor: 统一 hover tips 交互 ([d5474e2b](https://github.com/ljquan/aitu/commit/d5474e2b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.32 (2026-04-18)

### 🚀 Features

- 支持资产嵌入的尺寸调整和工具图标优化 ([7d05d56b](https://github.com/ljquan/aitu/commit/7d05d56b))
- 统一视频展示为海报优先并支持降级播放 ([a2ad5fd6](https://github.com/ljquan/aitu/commit/a2ad5fd6))
- 对齐爆款视频与爆款MV生成页交互 ([8864fac4](https://github.com/ljquan/aitu/commit/8864fac4))
- 支持镜头草稿保存和素材库视频插入 ([c808c822](https://github.com/ljquan/aitu/commit/c808c822))
- 串行化爆款视频批量生成 ([df558f3e](https://github.com/ljquan/aitu/commit/df558f3e))
- 优化多图批量生成锚点的位置规划与任务匹配 ([84461d2b](https://github.com/ljquan/aitu/commit/84461d2b))
- 拆分多图生成反馈为独立锚点 ([21471bec](https://github.com/ljquan/aitu/commit/21471bec))
- 引入生图锚点反馈初版框架 ([99c1a521](https://github.com/ljquan/aitu/commit/99c1a521))

### 🩹 Fixes

- 完善素材选择与素材插入体验 ([88c63210](https://github.com/ljquan/aitu/commit/88c63210))
- 优化知识库素材加载与媒体预览释放 ([626df4a9](https://github.com/ljquan/aitu/commit/626df4a9))
- 修复归档任务导致音频素材元数据丢失 ([94968bb2](https://github.com/ljquan/aitu/commit/94968bb2))
- 修复生成页多项 Bug 并优化单镜头生成参数透传 ([4732d060](https://github.com/ljquan/aitu/commit/4732d060))
- 修正 tuzi 图片路由与 AI 生图弹窗标题 ([ff9f7395](https://github.com/ljquan/aitu/commit/ff9f7395))
- 优化图片生成锚点的占位与加载反馈 ([20b71b12](https://github.com/ljquan/aitu/commit/20b71b12))

### 🔧 Chores

- bump version to 0.6.31 ([a086b160](https://github.com/ljquan/aitu/commit/a086b160))
- bump version to 0.6.30 ([a3c31d78](https://github.com/ljquan/aitu/commit/a3c31d78))
- bump version to 0.6.29 ([0e197f24](https://github.com/ljquan/aitu/commit/0e197f24))
- refactor(mv-creator): 重构为 分析→脚本→生成 三步流程，对齐爆款视频生成 ([9e61a023](https://github.com/ljquan/aitu/commit/9e61a023))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.31 (2026-04-17)

### 🚀 Features

- 统一视频展示为海报优先并支持降级播放 ([4c7a1032](https://github.com/ljquan/aitu/commit/4c7a1032))
- 对齐爆款视频与爆款MV生成页交互 ([ccf3c7b6](https://github.com/ljquan/aitu/commit/ccf3c7b6))
- 支持镜头草稿保存和素材库视频插入 ([3fac4d35](https://github.com/ljquan/aitu/commit/3fac4d35))
- 串行化爆款视频批量生成 ([3288d5cf](https://github.com/ljquan/aitu/commit/3288d5cf))
- improve markdown image resizing and placement ([1becd9b0](https://github.com/ljquan/aitu/commit/1becd9b0))
- 优化ppt导出 ([939e04f3](https://github.com/ljquan/aitu/commit/939e04f3))

### 🩹 Fixes

- 修复归档任务导致音频素材元数据丢失 ([2b4a450a](https://github.com/ljquan/aitu/commit/2b4a450a))
- 修复生成页多项 Bug 并优化单镜头生成参数透传 ([f698b70f](https://github.com/ljquan/aitu/commit/f698b70f))
- 修正 tuzi 图片路由与 AI 生图弹窗标题 ([8362bf8a](https://github.com/ljquan/aitu/commit/8362bf8a))

### 🔧 Chores

- bump version to 0.6.30 ([970fdf7d](https://github.com/ljquan/aitu/commit/970fdf7d))
- bump version to 0.6.29 ([4f85263b](https://github.com/ljquan/aitu/commit/4f85263b))
- refactor(mv-creator): 重构为 分析→脚本→生成 三步流程，对齐爆款视频生成 ([c9a3c42c](https://github.com/ljquan/aitu/commit/c9a3c42c))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- SaulgoodMan-C <271131037+SaulgoodMan-C@users.noreply.github.com>
- liangyufeng <l.yfeng@qq.com>

## 0.6.29 (2026-04-15)

### 🚀 Features

- 支持镜头草稿保存和素材库视频插入 ([eb691775](https://github.com/ljquan/aitu/commit/eb691775))
- 串行化爆款视频批量生成 ([b5f2ca6d](https://github.com/ljquan/aitu/commit/b5f2ca6d))

### 🔧 Chores

- 更新版本号至0.6.28并扩展素材类型定义 ([6a41a24d](https://github.com/ljquan/aitu/commit/6a41a24d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.28 (2026-04-15)

### 🚀 Features

- 引入音频卡片自适应尺寸及多工具窗口支持 ([92b47af9](https://github.com/ljquan/aitu/commit/92b47af9))
- 完善音频结果缓存并接入 MV 分镜任务 ([b108089d](https://github.com/ljquan/aitu/commit/b108089d))
- 爆款MV生成器增强 — 历史跳转、帧传递、音频驱动分镜 ([c29f4a81](https://github.com/ljquan/aitu/commit/c29f4a81))

### 🩹 Fixes

- 修复任务工作流同步幽灵日志刷屏 ([492ca8bf](https://github.com/ljquan/aitu/commit/492ca8bf))
- 区分 sw-debug llmapi 的音频与歌词生成 ([7421d206](https://github.com/ljquan/aitu/commit/7421d206))
- 补齐 sw-debug 的 llmapi JSON 结果展示 ([4a411bc6](https://github.com/ljquan/aitu/commit/4a411bc6))
- 修复 suno 多音频重复与时长错误 ([093cdf54](https://github.com/ljquan/aitu/commit/093cdf54))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.27 (2026-04-15)

### 🚀 Features

- 基于 pricing endpoints 推断 provider bindings ([1a161276](https://github.com/ljquan/aitu/commit/1a161276))
- 统一爆款音乐续写与 infill 能力 ([458375c0](https://github.com/ljquan/aitu/commit/458375c0))
- 优化爆款音乐生成工具流程与体验 ([ae2f0e12](https://github.com/ljquan/aitu/commit/ae2f0e12))
- 支持工具默认窗口行为并修复音乐任务卡片异常 ([788cbe04](https://github.com/ljquan/aitu/commit/788cbe04))

### 🩹 Fixes

- 首屏异步预热价格并补全 LLM 原始响应日志 ([4aa69578](https://github.com/ljquan/aitu/commit/4aa69578))
- 清理任务列表批量索引误渲染 0 ([211cb525](https://github.com/ljquan/aitu/commit/211cb525))
- 补齐 suno 续写所需 task_id ([703812e4](https://github.com/ljquan/aitu/commit/703812e4))
- 保留爆款音乐创作描述并上移错误提示 ([f3dce84e](https://github.com/ljquan/aitu/commit/f3dce84e))
- 优化音乐分析历史标题并隐藏续写入口 ([cd9b213d](https://github.com/ljquan/aitu/commit/cd9b213d))

### 🔧 Chores

- refactor: 统一 LLM 调用日志，所有大模型调用自动记录到 sw-debug LLM API 面板 ([7313b52f](https://github.com/ljquan/aitu/commit/7313b52f))
- style: 优化音乐分析器已生成片段布局 ([616b4633](https://github.com/ljquan/aitu/commit/616b4633))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.26 (2026-04-14)

### 🚀 Features

- 新增爆款音乐生成工具 ([9e5bd769](https://github.com/ljquan/aitu/commit/9e5bd769))
- 历史关联任务展开、生成回填、风格传递与脚本版本优化 ([d914bc12](https://github.com/ljquan/aitu/commit/d914bc12))
- 支持工具弹窗多窗口实例 ([247a9ff2](https://github.com/ljquan/aitu/commit/247a9ff2))
- 脚本版本管理，支持多版本切换 ([790e8272](https://github.com/ljquan/aitu/commit/790e8272))
- 优化视频分析与脚本改编交互 ([bc82abc6](https://github.com/ljquan/aitu/commit/bc82abc6))
- 视频分析任务接入队列并优化结果插入 ([0cfcb25c](https://github.com/ljquan/aitu/commit/0cfcb25c))
- 上传视频分析后自动提取首帧图片 ([c50dec54](https://github.com/ljquan/aitu/commit/c50dec54))

### 🩹 Fixes

- 修复音乐分析器兼容性并完善工作流展示 ([6cde07e0](https://github.com/ljquan/aitu/commit/6cde07e0))
- 统一持久化删除的二次确认 ([c717d30f](https://github.com/ljquan/aitu/commit/c717d30f))
- 统一确认弹窗与媒体预览提示词交互 ([4b007267](https://github.com/ljquan/aitu/commit/4b007267))
- 批量生成使用每个镜头独立的 batchId ([f593eef3](https://github.com/ljquan/aitu/commit/f593eef3))
- 修复 Markdown 卡片初始化阶段的 Milkdown editorView 异常 ([8badb0c7](https://github.com/ljquan/aitu/commit/8badb0c7))
- 在爆款视频分析页提示 gemini-mix 分组 ([55815a81](https://github.com/ljquan/aitu/commit/55815a81))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.25 (2026-04-14)

### 🩹 Fixes

- 修正视频分析中内联数据的MIME类型 ([55e6b903](https://github.com/ljquan/aitu/commit/55e6b903))
- 防止生成任务重复调用大模型 API ([f381d800](https://github.com/ljquan/aitu/commit/f381d800))
- 统一主应用和 sw-debug 的备份恢复核心逻辑 ([3c359631](https://github.com/ljquan/aitu/commit/3c359631))

### 🔧 Chores

- 更新应用版本并移除AI视频调试代码 ([9628c9ad](https://github.com/ljquan/aitu/commit/9628c9ad))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.24 (2026-04-13)

### 🩹 Fixes

- 收口 AI 视频弹窗受控模型同步环 ([6c1b074e](https://github.com/ljquan/aitu/commit/6c1b074e))
- 移除视频尺寸 Select 以绕开 TDesign Option 更新环 ([40d2a72c](https://github.com/ljquan/aitu/commit/40d2a72c))
- 补充 AI 视频弹窗调试标记并稳定图片标签依赖 ([33d9420e](https://github.com/ljquan/aitu/commit/33d9420e))

### 🔧 Chores

- 补充 AI 视频弹窗关键状态链路调试日志 ([316e3555](https://github.com/ljquan/aitu/commit/316e3555))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.23 (2026-04-13)

### 🩹 Fixes

- 收口 iframe 下 AI 视频弹窗的剩余更新环 ([58bfc2a0](https://github.com/ljquan/aitu/commit/58bfc2a0))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.22 (2026-04-13)

### 🩹 Fixes

- 收口 AI 视频弹窗参数回写循环 ([6baf3e06](https://github.com/ljquan/aitu/commit/6baf3e06))

### 🔧 Chores

- 更新应用版本至0.6.21并刷新构建时间 ([252a203b](https://github.com/ljquan/aitu/commit/252a203b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.21 (2026-04-13)

### 🚀 Features

- 知识库素材嵌入 — Milkdown 自定义节点插件 ([fec0e2a9](https://github.com/ljquan/aitu/commit/fec0e2a9))

### 🩹 Fixes

- 修复媒体库弹窗条件渲染和音频封面URL处理 ([d13e108b](https://github.com/ljquan/aitu/commit/d13e108b))
- 收口关闭态工具箱与素材库弹窗挂载，修复用户页 Hook 崩溃 ([45bfddb3](https://github.com/ljquan/aitu/commit/45bfddb3))
- iframe 环境下打开 AI 图片生成弹窗 Maximum update depth exceeded ([8c5a11fc](https://github.com/ljquan/aitu/commit/8c5a11fc))
- 避免 Milkdown 在 editorView 缺失时读取 markdown ([0d04c261](https://github.com/ljquan/aitu/commit/0d04c261))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.20 (2026-04-13)

### 🚀 Features

- 模型测试性价比评分 + 选择器收藏/淘汰标记 ([e3b694ac](https://github.com/ljquan/aitu/commit/e3b694ac))

### 🩹 Fixes

- 统一音频下载封面写入逻辑 ([97ab456a](https://github.com/ljquan/aitu/commit/97ab456a))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.19 (2026-04-12)

### 🚀 Features

- 增强错误处理与iframe测试支持 ([f4682ff8](https://github.com/ljquan/aitu/commit/f4682ff8))
- 音乐播放器支持知识库语音快捷操作 ([e53e6846](https://github.com/ljquan/aitu/commit/e53e6846))
- 右键菜单动态展示模型描述和文档链接 ([563376e1](https://github.com/ljquan/aitu/commit/563376e1))
- 集成供应商模型价格信息展示 ([8c011dbd](https://github.com/ljquan/aitu/commit/8c011dbd))
- 优化画布 Markdown 卡片与知识库联动 ([c04b9efd](https://github.com/ljquan/aitu/commit/c04b9efd))
- 增加内置模型推荐分并统一排序 ([bb65488e](https://github.com/ljquan/aitu/commit/bb65488e))
- 多选框增加全选/清除，修复测试本组模型数不一致 ([2ede78a7](https://github.com/ljquan/aitu/commit/2ede78a7))
- 更新默认模型至 Gemini 3.1 Pro Preview 并改进模型基准测试 ([3cce05df](https://github.com/ljquan/aitu/commit/3cce05df))
- 模型测试历史会话增加搜索与模态筛选 ([522b6c5d](https://github.com/ljquan/aitu/commit/522b6c5d))

### 🩹 Fixes

- 防白屏 — 全局错误边界 + 统一错误恢复 UI + 日志导出 ([6be795c9](https://github.com/ljquan/aitu/commit/6be795c9))
- 统一播放器速率控制并隔离播放缓存音频 ([5334ca60](https://github.com/ljquan/aitu/commit/5334ca60))
- 收敛 AI 媒体缓存语义与远程缓存去重 ([a35370f8](https://github.com/ljquan/aitu/commit/a35370f8))
- 补齐任务队列归档提示与历史数量 ([e8fb08d7](https://github.com/ljquan/aitu/commit/e8fb08d7))
- override TDesign Tooltip default max-width to display larger video ([1c9c73c5](https://github.com/ljquan/aitu/commit/1c9c73c5))
- 修复GitHub同步上下文未提供时的错误处理 ([eaf6a41d](https://github.com/ljquan/aitu/commit/eaf6a41d))

### 🔧 Chores

- style: 提升右键菜单 disabled 项可读性 ([91add984](https://github.com/ljquan/aitu/commit/91add984))
- style: fix config dashboard layout responsiveness in narrow container ([cf92bb0f](https://github.com/ljquan/aitu/commit/cf92bb0f))
- style: optimize model benchmark layout for smaller screens ([b5e36a01](https://github.com/ljquan/aitu/commit/b5e36a01))
- style: increase API Key tooltip width for better video visibility ([6688fb4c](https://github.com/ljquan/aitu/commit/6688fb4c))
- style: optimize settings layout and model selection UI ([b99baa5b](https://github.com/ljquan/aitu/commit/b99baa5b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.18 (2026-04-11)

### 🚀 Features

- 历史版本路径支持 + 未知元素类型容错 ([48a78cd4](https://github.com/ljquan/aitu/commit/48a78cd4))
- 优化模型批测入口与模型结果导出 ([358e44ae](https://github.com/ljquan/aitu/commit/358e44ae))
- 生成步骤交互优化 + 字段精简 ([c576d987](https://github.com/ljquan/aitu/commit/c576d987))
- refine model benchmark batch selection ([e18ff27e](https://github.com/ljquan/aitu/commit/e18ff27e))
- add model benchmark workbench ([d7b695b6](https://github.com/ljquan/aitu/commit/d7b695b6))
- 视频上传预览 + 生成页重新分析 + UI 优化 ([5323a31d](https://github.com/ljquan/aitu/commit/5323a31d))
- 脚本表单优化 + 生成链路增强 ([79ec5d77](https://github.com/ljquan/aitu/commit/79ec5d77))
- 长视频分段拼接全套优化 ([002dc30d](https://github.com/ljquan/aitu/commit/002dc30d))
- AI 文本生成结果统一以 Markdown Card 方式插入画布 ([c97fca2a](https://github.com/ljquan/aitu/commit/c97fca2a))
- 新增视频分析工具 + 重构 MCP 队列逻辑为公共模块 ([ac0f7331](https://github.com/ljquan/aitu/commit/ac0f7331))

### 🩹 Fixes

- 补齐推荐模型选择与默认分组去重 ([1a496766](https://github.com/ljquan/aitu/commit/1a496766))
- 收敛模型测试弹窗启动与状态同步 ([0529b331](https://github.com/ljquan/aitu/commit/0529b331))
- 设置弹窗单模型测试带入当前模型 ([9aa52c23](https://github.com/ljquan/aitu/commit/9aa52c23))
- 修复设置弹窗激活后仍被测试弹窗遮挡 ([99d0d0d4](https://github.com/ljquan/aitu/commit/99d0d0d4))
- 修复多窗口最新激活未置顶 ([1f956f2d](https://github.com/ljquan/aitu/commit/1f956f2d))
- ensure rawData is persisted and improve JSON display styling ([2aa967af](https://github.com/ljquan/aitu/commit/2aa967af))
- 修复 generateContent 路由与超时问题 ([7299a706](https://github.com/ljquan/aitu/commit/7299a706))
- 收紧 API key 错误判定，避免误开设置面板 ([21fffaa4](https://github.com/ljquan/aitu/commit/21fffaa4))
- 修复 AI 文本插入为普通文本 + Card 换行丢失 + 选中带标题 ([8479ac79](https://github.com/ljquan/aitu/commit/8479ac79))
- 修复模型搜索供应商展示与中文输入误选 ([2412e404](https://github.com/ljquan/aitu/commit/2412e404))
- 保留远程媒体原始 URL 语义 ([8f9f828f](https://github.com/ljquan/aitu/commit/8f9f828f))
- 深度用户页面加载内存溢出优化 ([71a0dfe2](https://github.com/ljquan/aitu/commit/71a0dfe2))

### 🔧 Chores

- refactor(winbox): 统一窗口 z-index 管理，修复多窗口遮挡与测试弹窗状态问题 ([6ec47b57](https://github.com/ljquan/aitu/commit/6ec47b57))
- style(model-benchmark): comprehensive UI/UX beautification and functional refinement ([2fe7bb15](https://github.com/ljquan/aitu/commit/2fe7bb15))
- docs: 补充 AI 文本插入必须传 label 走 Card 的编码规则 ([69bce1a9](https://github.com/ljquan/aitu/commit/69bce1a9))
- 添加搜索 ([fe650d69](https://github.com/ljquan/aitu/commit/fe650d69))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.17 (2026-04-09)

### 🚀 Features

- 优化音乐播放器布局与队列体验 ([4a76a43d](https://github.com/ljquan/aitu/commit/4a76a43d))
- 统一音乐播放器，始终显示播放列表标签栏，新增"全部语音"标签 ([a66e6d81](https://github.com/ljquan/aitu/commit/a66e6d81))
- 增加 TTS 播报设置入口 ([bd77e254](https://github.com/ljquan/aitu/commit/bd77e254))
- add canvas text read-aloud ([63c30e48](https://github.com/ljquan/aitu/commit/63c30e48))
- route audio entries into music player playback ([e8b9c4ff](https://github.com/ljquan/aitu/commit/e8b9c4ff))
- 增加音频播放列表与收藏能力 ([f8179794](https://github.com/ljquan/aitu/commit/f8179794))
- 素材库支持音频展示、缓存与拖拽插入 ([8c5a7e51](https://github.com/ljquan/aitu/commit/8c5a7e51))

### 🩹 Fixes

- 保持画布朗读在播放器切换时不中断 ([13b98cca](https://github.com/ljquan/aitu/commit/13b98cca))
- 音乐播放器时间展示回退\n\n问题描述：音乐播放器列表在拿不到音频时长时展示 --:--，无法向用户提供有效时间信息。\n修复思路：新增统一时间副标题格式化，优先展示解析/已有时长，缺失时回退展示素材生成时间。\n更新代码架构：在 MusicPlayerTool 收敛音频时间展示策略，并为素材列表补充元数据时长解析链路。 ([204da5a4](https://github.com/ljquan/aitu/commit/204da5a4))
- 修复音乐播放器最小化误触发底层播放控件\n\n问题描述:\n- 点击音乐播放器右上角最小化按钮时，事件会继续落到底层画布播放控件\n- 导致播放器最小化的同时误触发暂停/播放，交互结果与用户预期不一致\n\n修复思路:\n- 在最小化按钮上阻止 pointer/click 事件冒泡与默认行为\n- 使用 requestAnimationFrame 延后一帧执行最小化，避免同一点击链路被底层控件消费\n\n更新代码架构:\n- 收敛到音乐播放器工具内部按钮事件处理，不改播放服务与队列模型\n- 维持现有播放器/画布控件职责边界，仅修复 UI 事件穿透问题 ([6ab178e1](https://github.com/ljquan/aitu/commit/6ab178e1))
- 为无标题 markdown 卡片显示默认标题 ([6f96cfec](https://github.com/ljquan/aitu/commit/6f96cfec))
- markdown 元素按文本参与提示词 ([32a17163](https://github.com/ljquan/aitu/commit/32a17163))
- 保持 Agent 分类切模型不降级为文本 ([2fbe82de](https://github.com/ljquan/aitu/commit/2fbe82de))
- 优化设置弹窗小屏适配 ([39eeb5ba](https://github.com/ljquan/aitu/commit/39eeb5ba))
- unify canvas audio queue playback ([a0839a10](https://github.com/ljquan/aitu/commit/a0839a10))
- allow create menu on system playlist tabs ([b4837565](https://github.com/ljquan/aitu/commit/b4837565))
- unify playlist interactions and duration display ([f61bf142](https://github.com/ljquan/aitu/commit/f61bf142))
- dedupe local canvas files and media library ([ac6181d2](https://github.com/ljquan/aitu/commit/ac6181d2))
- 过滤辅助缓存条目避免封面图显示为独立素材 ([43bb958b](https://github.com/ljquan/aitu/commit/43bb958b))
- 修复本地拖入音频的标题和封面显示 ([9e7776ba](https://github.com/ljquan/aitu/commit/9e7776ba))
- 修复音频素材详情面板展示问题 ([e4a545a4](https://github.com/ljquan/aitu/commit/e4a545a4))
- 修复 Suno 参数下拉框不显示及版本默认值问题 ([2b658c37](https://github.com/ljquan/aitu/commit/2b658c37))

### 🔧 Chores

- refactor: 调整知识库工具分类 ([81e64fc8](https://github.com/ljquan/aitu/commit/81e64fc8))
- refactor(context-menu): 统一右键菜单公共组件 ([65739440](https://github.com/ljquan/aitu/commit/65739440))
- refactor: unify audio playlist tags ([babb531a](https://github.com/ljquan/aitu/commit/babb531a))
- refactor: unify audio track list and context menu ([0f544aae](https://github.com/ljquan/aitu/commit/0f544aae))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.16 (2026-04-08)

### 🩹 Fixes

- 修复 Suno 默认动作与 release 卡死问题 ([9d216539](https://github.com/ljquan/aitu/commit/9d216539))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.15 (2026-04-08)

### 🚀 Features

- 优化播放器定位、高度、拖拽和垂直布局 ([78038789](https://github.com/ljquan/aitu/commit/78038789))
- 完善音频预览与下载体验 ([d3f5a1d5](https://github.com/ljquan/aitu/commit/d3f5a1d5))
- sort models by freshness and persist model-scoped generation preferences ([98ad2a06](https://github.com/ljquan/aitu/commit/98ad2a06))
- add provider config shortcut ([14901355](https://github.com/ljquan/aitu/commit/14901355))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.14 (2026-04-08)

### 🚀 Features

- 支持 Suno 歌词任务与厂商识别能力 ([d3223043](https://github.com/ljquan/aitu/commit/d3223043))
- 恢复被误删掉代码 ([9166971c](https://github.com/ljquan/aitu/commit/9166971c))
- 恢复被误删掉代码 ([82134958](https://github.com/ljquan/aitu/commit/82134958))
- 优化代码 ([4ebfdf60](https://github.com/ljquan/aitu/commit/4ebfdf60))
- 优化代码 ([7f71ea6c](https://github.com/ljquan/aitu/commit/7f71ea6c))
- 新增模型 ([d8cf2816](https://github.com/ljquan/aitu/commit/d8cf2816))
- 优化导出 ([ea50f410](https://github.com/ljquan/aitu/commit/ea50f410))
- 增加 Stitch 设计工作流资产与规范 ([5d2c139b](https://github.com/ljquan/aitu/commit/5d2c139b))
- 增加画布音频节点与播放能力 ([6bf9d299](https://github.com/ljquan/aitu/commit/6bf9d299))
- 接入音频生成任务与工作流链路 ([9fe365ab](https://github.com/ljquan/aitu/commit/9fe365ab))
- 增加音频模态与 Suno 路由基础 ([d3d94f4c](https://github.com/ljquan/aitu/commit/d3d94f4c))
- 增加 Kling 参数适配 ([539a2827](https://github.com/ljquan/aitu/commit/539a2827))
- 增加 Kling 能力路由 ([03f2fec2](https://github.com/ljquan/aitu/commit/03f2fec2))
- 优化至形状可导出 ([210c68b9](https://github.com/ljquan/aitu/commit/210c68b9))
- 优化至适配画笔 ([a946b42f](https://github.com/ljquan/aitu/commit/a946b42f))
- 优化移动端设置与供应商配置体验 ([868f1fee](https://github.com/ljquan/aitu/commit/868f1fee))
- 增强文本多模态识图与供应商模型路由体验 ([ad47afef](https://github.com/ljquan/aitu/commit/ad47afef))
- 完善多供应商模型协议路由与 Sora 视频适配 ([5c217bd2](https://github.com/ljquan/aitu/commit/5c217bd2))
- 优化模型选择器供应商与厂商分层展示 ([f43a9e4d](https://github.com/ljquan/aitu/commit/f43a9e4d))
- 优化设置页模型发现与配置体验 ([868b0d45](https://github.com/ljquan/aitu/commit/868b0d45))
- 重构设置页并修复配置持久化 ([f7962788](https://github.com/ljquan/aitu/commit/f7962788))

### 🩹 Fixes

- persist dropdown selections and correct type fallback ([1d868c5e](https://github.com/ljquan/aitu/commit/1d868c5e))
- 修复 web 端音频任务类型检查失败 ([74e80377](https://github.com/ljquan/aitu/commit/74e80377))
- 优化音频节点内容布局与信息层级 ([526cd0ce](https://github.com/ljquan/aitu/commit/526cd0ce))
- 优化移动端音频播放器并恢复桌面端展示 ([ab75d70a](https://github.com/ljquan/aitu/commit/ab75d70a))
- 补充媒体任务兼容与路由回归 ([e09750e1](https://github.com/ljquan/aitu/commit/e09750e1))
- 完善音频入口与任务展示体验 ([10dc0abd](https://github.com/ljquan/aitu/commit/10dc0abd))
- 优化 Kling 参数展示 ([b7ad05d4](https://github.com/ljquan/aitu/commit/b7ad05d4))

### 🔧 Chores

- bump version to 0.6.13 ([1a3d4deb](https://github.com/ljquan/aitu/commit/1a3d4deb))
- bump version to 0.6.12 ([ecaf487e](https://github.com/ljquan/aitu/commit/ecaf487e))
- checkpoint current local changes ([fe2bdb7e](https://github.com/ljquan/aitu/commit/fe2bdb7e))
- 优化弹窗 ([16563720](https://github.com/ljquan/aitu/commit/16563720))
- featL：优化导出 ([8e78c7ff](https://github.com/ljquan/aitu/commit/8e78c7ff))
- 实现多供应商模型配置与按模型来源路由 ([979ff59d](https://github.com/ljquan/aitu/commit/979ff59d))
- 实现模型获取与按需添加流程 ([7d5f9ab8](https://github.com/ljquan/aitu/commit/7d5f9ab8))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liangyufeng <l.yfeng@qq.com>

## 0.6.12 (2026-03-31)

### 🚀 Features

- 隐藏原生滚动条 ([15e61dcb](https://github.com/ljquan/aitu/commit/15e61dcb))
- 重建多供应商模型路由与移动端配置体验 ([78de2528](https://github.com/ljquan/aitu/commit/78de2528))

### 🩹 Fixes

- 修复多供应商分支构建类型错误 ([541000cc](https://github.com/ljquan/aitu/commit/541000cc))
- 修复缩略图地址钩子语法错误 ([c8883799](https://github.com/ljquan/aitu/commit/c8883799))
- update app version to 0.6.11 and adjust build time ([8d8ad46a](https://github.com/ljquan/aitu/commit/8d8ad46a))

### ❤️  Thank You

- liangyufeng <l.yfeng@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.6.11 (2026-03-18)

### 🔧 Chores

- 更新应用版本至0.6.10并修正调整大小句柄常量 ([4bf18818](https://github.com/ljquan/aitu/commit/4bf18818))
- fixed: 兼容base64图片返回 ([94d4a81c](https://github.com/ljquan/aitu/commit/94d4a81c))
- fixed:修复部署失败 ([9ecdebcc](https://github.com/ljquan/aitu/commit/9ecdebcc))
- fixed:修复素材库删除的bug ([6ac4bf95](https://github.com/ljquan/aitu/commit/6ac4bf95))
- fixed:修复素材库删除的bug ([c93d449e](https://github.com/ljquan/aitu/commit/c93d449e))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liangyufeng <l.yfeng@qq.com>

## 0.6.10 (2026-03-16)

### 🚀 Features

- 修改部署失败的问题 ([23533dd2](https://github.com/ljquan/aitu/commit/23533dd2))
- 添加导出ppt的功能 ([08e4fd52](https://github.com/ljquan/aitu/commit/08e4fd52))
- 持久化 AI 生成参数偏好 ([dbf42e78](https://github.com/ljquan/aitu/commit/dbf42e78))
- 添加页面刷新后视频任务恢复和工作流同步机制 ([8daecd7b](https://github.com/ljquan/aitu/commit/8daecd7b))
- 优化画布上插入内容让其可滚动 ([76024c85](https://github.com/ljquan/aitu/commit/76024c85))
- 优化agent回答文本框 ([d706c6ed](https://github.com/ljquan/aitu/commit/d706c6ed))
- 优化知识库对话ai回答内容将其渲染为对应的markdown格式&优化skill生成的内容让外层文本框高度自适应内容高度 ([cb76e4df](https://github.com/ljquan/aitu/commit/cb76e4df))

### 🩹 Fixes

- 修复切换画板时刷新页面丢失当前画板的问题 ([c164a1dc](https://github.com/ljquan/aitu/commit/c164a1dc))

### 🔧 Chores

- 更新构建时间戳 ([431af243](https://github.com/ljquan/aitu/commit/431af243))
- feat：优化文本框高度 ([435cc865](https://github.com/ljquan/aitu/commit/435cc865))

### ❤️  Thank You

- liangyufeng <l.yfeng@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.6.9 (2026-03-08)

### 🚀 Features

- 添加页面刷新后恢复视频任务轮询的功能 ([d434c165](https://github.com/ljquan/aitu/commit/d434c165))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.6.8 (2026-03-07)

### 🚀 Features

- add backup restoration functionality with automatic chunking support ([7d76899a](https://github.com/ljquan/aitu/commit/7d76899a))
- 支持剪贴板图片粘贴 ([367830ca](https://github.com/ljquan/aitu/commit/367830ca))
- 优化缩放累计误差 ([f5330602](https://github.com/ljquan/aitu/commit/f5330602))
- 优化多行输入取消聚焦会换行的问题 ([4ab79120](https://github.com/ljquan/aitu/commit/4ab79120))
- 新增插入画布开关 ([60f6c041](https://github.com/ljquan/aitu/commit/60f6c041))
- 优化 ([1630ecbf](https://github.com/ljquan/aitu/commit/1630ecbf))

### 🩹 Fixes

- 修复批量生图模型尺寸失效 ([eee26c35](https://github.com/ljquan/aitu/commit/eee26c35))
- 仅为 gemini-3.1-flash-image-preview 开放新增比例并按模型过滤尺寸选项 ([4b3600d7](https://github.com/ljquan/aitu/commit/4b3600d7))
- update app version to 0.6.7 and adjust build time in version.json; refactor WeakRef usage in tracking.types.ts ([ad9d7769](https://github.com/ljquan/aitu/commit/ad9d7769))

### 🔧 Chores

- feat：优化缩放文本框&实现点击输入 ([4ac4244e](https://github.com/ljquan/aitu/commit/4ac4244e))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liangyufeng <l.yfeng@qq.com>

## 0.6.7 (2026-03-04)

### 🚀 Features

- 添加图层 ([74fc6e51](https://github.com/ljquan/aitu/commit/74fc6e51))
- 优化Service Worker激活和CDN策略 ([e8ec6272](https://github.com/ljquan/aitu/commit/e8ec6272))
- 引入baoyu-skill ([5b04670b](https://github.com/ljquan/aitu/commit/5b04670b))

### 🔧 Chores

- 更新版本至0.6.6并调整CDN优先级 ([21a5d6ff](https://github.com/ljquan/aitu/commit/21a5d6ff))
- bump version to 0.6.6 ([95f54096](https://github.com/ljquan/aitu/commit/95f54096))
- bump version to 0.6.5 ([c8c22e00](https://github.com/ljquan/aitu/commit/c8c22e00))
- bump version to 0.6.4 ([42f24424](https://github.com/ljquan/aitu/commit/42f24424))
- bump version to 0.6.3 ([28217b94](https://github.com/ljquan/aitu/commit/28217b94))
- refactor: replace video with tutorial link in settings dialog and auth components ([94675952](https://github.com/ljquan/aitu/commit/94675952))
- 优化 ([60a5d1d4](https://github.com/ljquan/aitu/commit/60a5d1d4))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liangyufeng <l.yfeng@qq.com>
- liquidliang <ljquan@qq.com>

## 0.6.6 (2026-02-28)

### 🔧 Chores

- bump version to 0.6.5 ([c8c22e00](https://github.com/ljquan/aitu/commit/c8c22e00))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.6.5 (2026-02-28)

### 🚀 Features

- 优化Service Worker激活和CDN策略 ([e8ec6272](https://github.com/ljquan/aitu/commit/e8ec6272))

### 🔧 Chores

- bump version to 0.6.4 ([42f24424](https://github.com/ljquan/aitu/commit/42f24424))
- 优化 ([60a5d1d4](https://github.com/ljquan/aitu/commit/60a5d1d4))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.6.4 (2026-02-28)

### 🚀 Features

- 优化Service Worker激活和CDN策略 ([e8ec6272](https://github.com/ljquan/aitu/commit/e8ec6272))
- 引入baoyu-skill ([5b04670b](https://github.com/ljquan/aitu/commit/5b04670b))

### 🩹 Fixes

- 修复 GitHub Actions CI 配置以支持 pnpm ([582b46cc](https://github.com/ljquan/aitu/commit/582b46cc))

### 🔧 Chores

- bump version to 0.6.3 ([28217b94](https://github.com/ljquan/aitu/commit/28217b94))
- 多文件禁用缓存确保版本与日志数据实时更新 ([099d8807](https://github.com/ljquan/aitu/commit/099d8807))
- 升级版本至0.6.2并更新构建时间与版本信息 ([f3b13616](https://github.com/ljquan/aitu/commit/f3b13616))
- 优化 ([60a5d1d4](https://github.com/ljquan/aitu/commit/60a5d1d4))
- refactor: 模型命名重构与功能增强 ([1bd8048a](https://github.com/ljquan/aitu/commit/1bd8048a))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.3 (2026-02-28)

### 🚀 Features

- 引入baoyu-skill ([5b04670b](https://github.com/ljquan/aitu/commit/5b04670b))
- 重构版本相关菜单与页面，优化样式与交互体验 ([e40635b9](https://github.com/ljquan/aitu/commit/e40635b9))
- 升级版本至0.6.1，优化部署与生成流程，集成多模型适配器 ([784c58a8](https://github.com/ljquan/aitu/commit/784c58a8))

### 🩹 Fixes

- 修复 GitHub Actions CI 配置以支持 pnpm ([582b46cc](https://github.com/ljquan/aitu/commit/582b46cc))

### 🔧 Chores

- 多文件禁用缓存确保版本与日志数据实时更新 ([099d8807](https://github.com/ljquan/aitu/commit/099d8807))
- 升级版本至0.6.2并更新构建时间与版本信息 ([f3b13616](https://github.com/ljquan/aitu/commit/f3b13616))
- bump version to 0.6.2 ([499797ca](https://github.com/ljquan/aitu/commit/499797ca))
- refactor: 模型命名重构与功能增强 ([1bd8048a](https://github.com/ljquan/aitu/commit/1bd8048a))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.6.2 (2026-02-27)

### 🚀 Features

- 重构版本相关菜单与页面，优化样式与交互体验 ([e40635b9](https://github.com/ljquan/aitu/commit/e40635b9))
- 升级版本至0.6.1，优化部署与生成流程，集成多模型适配器 ([784c58a8](https://github.com/ljquan/aitu/commit/784c58a8))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.6.1 (2026-02-26)

### 🚀 Features

- 为 ImageGenerationParams 新增 params 字段支持模型特定参数 ([ac10ed55](https://github.com/ljquan/aitu/commit/ac10ed55))
- 版本日志菜单 + CHANGELOG.md 自动同步到 changelog.json ([51bb033e](https://github.com/ljquan/aitu/commit/51bb033e))
- 新增多个系统技能常量定义 ([f30c3ab6](https://github.com/ljquan/aitu/commit/f30c3ab6))
- 支持双击卡片打开知识库并关联笔记 ([8301bce3](https://github.com/ljquan/aitu/commit/8301bce3))
- 为卡片元素添加复制文本功能 ([f1a06a9a](https://github.com/ljquan/aitu/commit/f1a06a9a))
- 实现 Markdown 粘贴和知识库集成的 Card 标签贴元素 ([7b590d30](https://github.com/ljquan/aitu/commit/7b590d30))
- 统一系统与自定义Skill执行路径并支持角色扮演模式 ([58204689](https://github.com/ljquan/aitu/commit/58204689))
- 新增Skill工作流DSL解析与知识库集成 ([f0df843c](https://github.com/ljquan/aitu/commit/f0df843c))
- 新增知识提取与同步功能 ([093dd25d](https://github.com/ljquan/aitu/commit/093dd25d))
- 完整支持多图生成结果的存储、展示与预览 ([2e5df25b](https://github.com/ljquan/aitu/commit/2e5df25b))
- 集成 Seedream 5.0 并优化模型适配器匹配机制 ([cc4232fd](https://github.com/ljquan/aitu/commit/cc4232fd))
- 优化模型参数处理与自定义参数透传链路 ([3eceb994](https://github.com/ljquan/aitu/commit/3eceb994))
- 集成即梦（Seedream + Seedance）模型，修复自定义参数透传链路 ([31f857bb](https://github.com/ljquan/aitu/commit/31f857bb))
- 升级 ([d8eb1502](https://github.com/ljquan/aitu/commit/d8eb1502))
- 添加模型选择器厂商分类（VendorTabPanel 左右分栏布局） ([55a18a84](https://github.com/ljquan/aitu/commit/55a18a84))
- 添加 Flux 图片生成适配器，重构 adapter 路由与回调传递 ([f6b1670e](https://github.com/ljquan/aitu/commit/f6b1670e))
- 集成 Milkdown Markdown 编辑器并优化幻灯片播放 ([9e66bf4c](https://github.com/ljquan/aitu/commit/9e66bf4c))
- 接入 Midjourney 图片模型适配 ([62266a31](https://github.com/ljquan/aitu/commit/62266a31))
- 接入Kling视频模型适配 ([a9c0eade](https://github.com/ljquan/aitu/commit/a9c0eade))

### 🩹 Fixes

- 修复视频时长解析空值NaN并同步版本与更新说明 ([e1e4137c](https://github.com/ljquan/aitu/commit/e1e4137c))
- 移除视频创作技能 ([33fe21bc](https://github.com/ljquan/aitu/commit/33fe21bc))
- 修复卡片标题重复显示和交互事件问题 ([f7409839](https://github.com/ljquan/aitu/commit/f7409839))
- 修复删除上传图片后 hover 预览大图未消失的问题 ([f9e3ee4f](https://github.com/ljquan/aitu/commit/f9e3ee4f))
- 修复 Seedream 5.0 lite 模型 ID、3K 比例参数及底部输入栏参数丢失问题 ([98912c16](https://github.com/ljquan/aitu/commit/98912c16))
- 修复上下文菜单z-index硬编码问题 ([3373b168](https://github.com/ljquan/aitu/commit/3373b168))
- 提高上下文菜单的z-index以解决遮挡问题 ([853f7868](https://github.com/ljquan/aitu/commit/853f7868))
- 修复外部签名 URL 的 CORS 和参数破坏问题 ([e0491e50](https://github.com/ljquan/aitu/commit/e0491e50))
- 修复签名 URL（TOS）因 Referer 校验导致缩略图/插入/下载 403 ([262eea92](https://github.com/ljquan/aitu/commit/262eea92))

### 🔧 Chores

- update build artifacts for version 0.5.95 ([ef974603](https://github.com/ljquan/aitu/commit/ef974603))
- bump version to 0.5.95 ([1a7a018f](https://github.com/ljquan/aitu/commit/1a7a018f))
- refactor(web): 优化类型定义和构建配置 refactor(sw): 增强类型安全处理 refactor(dawnix): 完善类型导入和配置 ([84285d9e](https://github.com/ljquan/aitu/commit/84285d9e))
- docs: 新增知识库、命令面板和任务队列文档并更新相关内容 ([4b3aedf8](https://github.com/ljquan/aitu/commit/4b3aedf8))
- docs(settings): 在API Key说明中添加演示视频链接 ([d4e24da5](https://github.com/ljquan/aitu/commit/d4e24da5))
- refactor(knowledge-base): 统一默认目录并简化目录类型映射 ([bf7a367d](https://github.com/ljquan/aitu/commit/bf7a367d))
- docs: 更新 CLAUDE.md 反映多模型适配器架构 ([4bbebd99](https://github.com/ljquan/aitu/commit/4bbebd99))
- Fix seedream adapter routing and dropdown layout ([f4bb5a74](https://github.com/ljquan/aitu/commit/f4bb5a74))
- fixed:修复ppt新加的内容在上方的问题 ([f4e345f7](https://github.com/ljquan/aitu/commit/f4e345f7))
- 知识库 ([5b8f2bdb](https://github.com/ljquan/aitu/commit/5b8f2bdb))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liangyufeng <l.yfeng@qq.com>
- liquid <ljquan@qq.com>

## 0.5.95 (2026-02-12)

### 🚀 Features

- 完整支持多图生成结果的存储、展示与预览 ([2e5df25b](https://github.com/ljquan/aitu/commit/2e5df25b))
- 集成 Seedream 5.0 并优化模型适配器匹配机制 ([cc4232fd](https://github.com/ljquan/aitu/commit/cc4232fd))
- 优化模型参数处理与自定义参数透传链路 ([3eceb994](https://github.com/ljquan/aitu/commit/3eceb994))
- 集成即梦（Seedream + Seedance）模型，修复自定义参数透传链路 ([31f857bb](https://github.com/ljquan/aitu/commit/31f857bb))
- 升级 ([d8eb1502](https://github.com/ljquan/aitu/commit/d8eb1502))
- 优化PPT相关能力 ([7f592465](https://github.com/ljquan/aitu/commit/7f592465))
- 添加模型选择器厂商分类（VendorTabPanel 左右分栏布局） ([55a18a84](https://github.com/ljquan/aitu/commit/55a18a84))
- 添加 Flux 图片生成适配器，重构 adapter 路由与回调传递 ([f6b1670e](https://github.com/ljquan/aitu/commit/f6b1670e))
- 添加套索选择工具及工具栏/命令面板集成 ([0d5e1d82](https://github.com/ljquan/aitu/commit/0d5e1d82))
- 添加 Frame 和幻灯片播放功能 ([c9859671](https://github.com/ljquan/aitu/commit/c9859671))
- implement new canvas features and command palette ([47dfcf12](https://github.com/ljquan/aitu/commit/47dfcf12))
- enhance logging and error handling in WorkflowEngine ([5074339b](https://github.com/ljquan/aitu/commit/5074339b))
- improve fallback engine handling and logging in workflow submission service ([88a7199e](https://github.com/ljquan/aitu/commit/88a7199e))
- add batch clear failed tasks button in generation task list ([e303baf8](https://github.com/ljquan/aitu/commit/e303baf8))
- enhance logging and error handling in AI analysis and agent execution ([cc03ce1c](https://github.com/ljquan/aitu/commit/cc03ce1c))
- enhance session replay management and error handling ([8a190371](https://github.com/ljquan/aitu/commit/8a190371))
- improve Service Worker channel validation for streaming API calls ([8f81e6ef](https://github.com/ljquan/aitu/commit/8f81e6ef))
- unify Service Worker availability checks and enforce main thread executor in fallback scenarios ([e27d14e0](https://github.com/ljquan/aitu/commit/e27d14e0))
- enhance workflow submission and error handling ([3365fdfc](https://github.com/ljquan/aitu/commit/3365fdfc))
- optimize analytics reporting and payload management ([fef7bf06](https://github.com/ljquan/aitu/commit/fef7bf06))
- add custom tools sync and prevent remote task resumption ([f296875d](https://github.com/ljquan/aitu/commit/f296875d))
- implement workflow handler initialization from IndexedDB ([943419ec](https://github.com/ljquan/aitu/commit/943419ec))
- enhance error handling and logging in Service Worker and task management ([167a559a](https://github.com/ljquan/aitu/commit/167a559a))
- implement video model adapters and enhance video generation ([982313f3](https://github.com/ljquan/aitu/commit/982313f3))
- enhance SW task queue service with fallback mechanisms and canvas operation handling ([390bb155](https://github.com/ljquan/aitu/commit/390bb155))
- add base64 image preview functionality ([fba4fe7f](https://github.com/ljquan/aitu/commit/fba4fe7f))
- 接入 Midjourney 图片模型适配 ([62266a31](https://github.com/ljquan/aitu/commit/62266a31))
- implement image fitting utility and enhance video processing ([25746d6b](https://github.com/ljquan/aitu/commit/25746d6b))
- enhance analytics and reporting functionality ([30a9bbfd](https://github.com/ljquan/aitu/commit/30a9bbfd))
- enhance video handling and task queue management ([4757a0d4](https://github.com/ljquan/aitu/commit/4757a0d4))
- 接入Kling视频模型适配 ([a9c0eade](https://github.com/ljquan/aitu/commit/a9c0eade))
- add master badge and enhance Gist handling ([1dc71a99](https://github.com/ljquan/aitu/commit/1dc71a99))
- implement failed URL caching for external image requests ([4376be0c](https://github.com/ljquan/aitu/commit/4376be0c))
- integrate fake-indexeddb and refactor media executor ([dae0bb8a](https://github.com/ljquan/aitu/commit/dae0bb8a))
- implement unified media execution and workflow enhancements ([900db04d](https://github.com/ljquan/aitu/commit/900db04d))
- add Gist management panel and enhance sync logging ([061423a9](https://github.com/ljquan/aitu/commit/061423a9))
- implement soft delete and data recovery features ([3a93bf08](https://github.com/ljquan/aitu/commit/3a93bf08))
- 任务队列同步下载远程数据时双向合并 ([27064a50](https://github.com/ljquan/aitu/commit/27064a50))
- implement deletion sync with recycle bin ([a36176ba](https://github.com/ljquan/aitu/commit/a36176ba))
- implement data encryption and synchronization enhancements ([c0518af5](https://github.com/ljquan/aitu/commit/c0518af5))
- enhance thumbnail request handling with parameter prioritization ([8b0b95bf](https://github.com/ljquan/aitu/commit/8b0b95bf))
- support opening tools via URL parameter and display tool icons in window title ([9abfb3f3](https://github.com/ljquan/aitu/commit/9abfb3f3))
- enhance board ID management via URL parameters and improve user interaction ([738f8b9b](https://github.com/ljquan/aitu/commit/738f8b9b))
- 改进工作流恢复机制和错误处理 ([d27939f8](https://github.com/ljquan/aitu/commit/d27939f8))
- move ai_analyze to SW and improve debug panel logging ([50c94058](https://github.com/ljquan/aitu/commit/50c94058))
- implement LLM API log selection and batch actions ([070801ca](https://github.com/ljquan/aitu/commit/070801ca))

### 🩹 Fixes

- 修复外部签名 URL 的 CORS 和参数破坏问题 ([e0491e50](https://github.com/ljquan/aitu/commit/e0491e50))
- 修复签名 URL（TOS）因 Referer 校验导致缩略图/插入/下载 403 ([262eea92](https://github.com/ljquan/aitu/commit/262eea92))
- 修复tab 同步问题 ([7c390191](https://github.com/ljquan/aitu/commit/7c390191))
- 视频任务状态 ([ea3c2ccc](https://github.com/ljquan/aitu/commit/ea3c2ccc))
- update DelegatedOperation type usage in workflow submission service ([ac40be77](https://github.com/ljquan/aitu/commit/ac40be77))
- guard video model config lookups ([16473751](https://github.com/ljquan/aitu/commit/16473751))
- 降级模式图片/视频带参考图与 1MB 限制 ([66db4935](https://github.com/ljquan/aitu/commit/66db4935))
- 修复视频 API 请求格式错误 ([0262697f](https://github.com/ljquan/aitu/commit/0262697f))
- add missing apiKey to videoConfig in SW initialization ([a1971c4e](https://github.com/ljquan/aitu/commit/a1971c4e))
- enhance workflow submission with timeout and retry logic ([84e9436c](https://github.com/ljquan/aitu/commit/84e9436c))
- enhance manifest decryption error handling ([163bcee1](https://github.com/ljquan/aitu/commit/163bcee1))
- initialize session model from global settings ([24ec69fa](https://github.com/ljquan/aitu/commit/24ec69fa))

### 🔧 Chores

- bump version to 0.5.94 ([4a96c339](https://github.com/ljquan/aitu/commit/4a96c339))
- bump version to 0.5.93 ([3f6e583c](https://github.com/ljquan/aitu/commit/3f6e583c))
- bump version to 0.5.92 ([c32b257c](https://github.com/ljquan/aitu/commit/c32b257c))
- bump version to 0.5.91 ([13442303](https://github.com/ljquan/aitu/commit/13442303))
- bump version to 0.5.90 ([773cdb08](https://github.com/ljquan/aitu/commit/773cdb08))
- 更新应用版本至 0.5.89 ([8ff11e56](https://github.com/ljquan/aitu/commit/8ff11e56))
- bump version to 0.5.89 ([85635880](https://github.com/ljquan/aitu/commit/85635880))
- update version to 0.5.88 and improve task storage handling ([1adae49f](https://github.com/ljquan/aitu/commit/1adae49f))
- bump version to 0.5.88 ([af685dde](https://github.com/ljquan/aitu/commit/af685dde))
- bump version to 0.5.87 ([de16ae04](https://github.com/ljquan/aitu/commit/de16ae04))
- bump version to 0.5.86 ([2394021b](https://github.com/ljquan/aitu/commit/2394021b))
- bump version to 0.5.85 ([8e45567e](https://github.com/ljquan/aitu/commit/8e45567e))
- bump version to 0.5.84 ([1aea9496](https://github.com/ljquan/aitu/commit/1aea9496))
- bump version to 0.5.83 ([322118fb](https://github.com/ljquan/aitu/commit/322118fb))
- bump version to 0.5.82 ([692f0eff](https://github.com/ljquan/aitu/commit/692f0eff))
- update version to 0.5.82 and adjust build time ([87a5198d](https://github.com/ljquan/aitu/commit/87a5198d))
- bump version to 0.5.81 ([3ab8846d](https://github.com/ljquan/aitu/commit/3ab8846d))
- update app version to 0.5.80 and adjust build time ([dbdb729b](https://github.com/ljquan/aitu/commit/dbdb729b))
- bump version to 0.5.80 ([e8b67aee](https://github.com/ljquan/aitu/commit/e8b67aee))
- bump version to 0.5.79 ([b175bfaf](https://github.com/ljquan/aitu/commit/b175bfaf))
- update postmessage-duplex dependency to version 1.2.0 ([2bea89d7](https://github.com/ljquan/aitu/commit/2bea89d7))
- enhance project configuration and task management ([643e69fa](https://github.com/ljquan/aitu/commit/643e69fa))
- update app version to 0.5.78 and adjust styles for mobile badge display ([afaf093b](https://github.com/ljquan/aitu/commit/afaf093b))
- bump version to 0.5.78 ([b0f3df9e](https://github.com/ljquan/aitu/commit/b0f3df9e))
- update version to 0.5.77 and adjust build time ([f11329fe](https://github.com/ljquan/aitu/commit/f11329fe))
- bump version to 0.5.77 ([e158b459](https://github.com/ljquan/aitu/commit/e158b459))
- bump version to 0.5.76 ([22ef45ad](https://github.com/ljquan/aitu/commit/22ef45ad))
- bump version to 0.5.75 ([4a0e9128](https://github.com/ljquan/aitu/commit/4a0e9128))
- update version to 0.5.74 and adjust build time ([c7eb7979](https://github.com/ljquan/aitu/commit/c7eb7979))
- bump version to 0.5.74 ([1fc59675](https://github.com/ljquan/aitu/commit/1fc59675))
- update version to 0.5.73 and improve task loading logic ([99b268e6](https://github.com/ljquan/aitu/commit/99b268e6))
- bump version to 0.5.73 ([06a61e81](https://github.com/ljquan/aitu/commit/06a61e81))
- update version to 0.5.72 and enhance LLM API logging ([3cdc13ea](https://github.com/ljquan/aitu/commit/3cdc13ea))
- bump version to 0.5.72 ([df013d28](https://github.com/ljquan/aitu/commit/df013d28))
- update app version to 0.5.71 and adjust build time ([504fee1c](https://github.com/ljquan/aitu/commit/504fee1c))
- bump version to 0.5.71 ([65d6716c](https://github.com/ljquan/aitu/commit/65d6716c))
- bump version to 0.5.70 ([9847d773](https://github.com/ljquan/aitu/commit/9847d773))
- update build time and refactor imports for consistency ([036cce52](https://github.com/ljquan/aitu/commit/036cce52))
- update app version to 0.5.69 and adjust build time in version.json ([af1fb113](https://github.com/ljquan/aitu/commit/af1fb113))
- bump version to 0.5.69 ([f51c14c0](https://github.com/ljquan/aitu/commit/f51c14c0))
- bump version to 0.5.68 ([49329c41](https://github.com/ljquan/aitu/commit/49329c41))
- update app version to 0.5.67 and adjust build time ([fedfebd4](https://github.com/ljquan/aitu/commit/fedfebd4))
- bump version to 0.5.67 ([70486b77](https://github.com/ljquan/aitu/commit/70486b77))
- bump version to 0.5.66 ([d0eafd68](https://github.com/ljquan/aitu/commit/d0eafd68))
- clean up debug console logs and fix winbox icon handling ([21a66663](https://github.com/ljquan/aitu/commit/21a66663))
- update version and build time, refine toolbar styles, and ensure consistent type exports ([4b3a7842](https://github.com/ljquan/aitu/commit/4b3a7842))
- update app version to 0.5.64 and adjust build time ([1772d5cd](https://github.com/ljquan/aitu/commit/1772d5cd))
- bump version to 0.5.64 ([c820a822](https://github.com/ljquan/aitu/commit/c820a822))
- docs: 更新 CLAUDE.md 反映多模型适配器架构 ([4bbebd99](https://github.com/ljquan/aitu/commit/4bbebd99))
- Fix seedream adapter routing and dropdown layout ([f4bb5a74](https://github.com/ljquan/aitu/commit/f4bb5a74))
- fixed:修复ppt新加的内容在上方的问题 ([f4e345f7](https://github.com/ljquan/aitu/commit/f4e345f7))
- ppt ([98a60a56](https://github.com/ljquan/aitu/commit/98a60a56))
- fix：任务状态不同步 ([8689c846](https://github.com/ljquan/aitu/commit/8689c846))
- docs(claude): 添加新规则 - RxJS事件对象引用导致React.memo失效、API错误字段类型安全 ([d553d884](https://github.com/ljquan/aitu/commit/d553d884))
- docs(claude): 添加新规则 - 数值范围转换规则、列表索引ID追踪 ([fbb91726](https://github.com/ljquan/aitu/commit/fbb91726))
- refactor: remove unused SW RPC methods and optimize communication ([e36bbc76](https://github.com/ljquan/aitu/commit/e36bbc76))
- docs(claude): 添加新规则 - 编程式选中元素需用 addSelectionWithTemporaryElements 触发渲染 ([a2b0cd01](https://github.com/ljquan/aitu/commit/a2b0cd01))
- docs(claude): 添加新规则 - 自定义 Plait 组件 onContextChanged 必须处理 viewport 变化 ([bfad96d5](https://github.com/ljquan/aitu/commit/bfad96d5))
- docs(claude): 更新规则 - 全屏展示画布局部内容改用 viewport+隐藏UI+蒙层挖洞方案 ([e09e0e80](https://github.com/ljquan/aitu/commit/e09e0e80))
- docs(claude): 添加新规则 - 全屏展示画布局部内容用 toImage 截图独立渲染 ([649c02bf](https://github.com/ljquan/aitu/commit/649c02bf))
- docs(claude): 添加新规则 - Plait Board Viewport 缩放+平移用 updateViewport 一步完成 ([643cc38d](https://github.com/ljquan/aitu/commit/643cc38d))
- fixed:本次修改解决了ai生成图片中点击提示的下拉框手机端溢出问题&agent生成长方形图片容器溢出问题 ([64c4da2d](https://github.com/ljquan/aitu/commit/64c4da2d))
- docs(claude): 添加新规则 - 模块迁移接口完整性 ([afb95640](https://github.com/ljquan/aitu/commit/afb95640))
- docs: 添加编码规则 - 统计上报旁路化 ([133b6a72](https://github.com/ljquan/aitu/commit/133b6a72))
- docs: update localhost port references from 4200 to 7200 ([5a10c4c4](https://github.com/ljquan/aitu/commit/5a10c4c4))
- docs: 添加编码规则 - 配置同步到 IndexedDB 供 SW 读取 ([db99fb6d](https://github.com/ljquan/aitu/commit/db99fb6d))
- docs: 添加编码规则 - 枚举不能使用 import type 导入 ([26360e85](https://github.com/ljquan/aitu/commit/26360e85))
- 简化方案 ([12525090](https://github.com/ljquan/aitu/commit/12525090))
- refactor: simplify architecture by removing DDD layers and unifying types ([ad341a4f](https://github.com/ljquan/aitu/commit/ad341a4f))
- docs: 添加配置对象深拷贝规则 ([0002654a](https://github.com/ljquan/aitu/commit/0002654a))
- perf: 优化同步上传性能，避免 UI 阻塞 ([cbe11e08](https://github.com/ljquan/aitu/commit/cbe11e08))
- docs: 添加 LLM API 日志记录异步任务 remoteId 规则 ([708131f7](https://github.com/ljquan/aitu/commit/708131f7))
- docs: 添加编码规则 - SW 初始化统一入口 ([f13f809a](https://github.com/ljquan/aitu/commit/f13f809a))
- docs: 添加编码规则 - 模块循环依赖处理 ([e6a39db6](https://github.com/ljquan/aitu/commit/e6a39db6))
- docs: 添加降级模式任务执行规则 ([e0f459a6](https://github.com/ljquan/aitu/commit/e0f459a6))
- refactor: 清理调试日志和未使用代码 ([066eb12d](https://github.com/ljquan/aitu/commit/066eb12d))
- docs: 更新工具函数规则 - 添加新模块和避免不必要包装 ([8dfcf4a3](https://github.com/ljquan/aitu/commit/8dfcf4a3))
- docs: 添加编码规则 - 降级路径功能一致性 ([5c86d02b](https://github.com/ljquan/aitu/commit/5c86d02b))
- docs: 添加 LLM 响应格式兼容性和工作流状态同步规则 ([3d844c42](https://github.com/ljquan/aitu/commit/3d844c42))
- docs: 添加编码规则 - IndexedDB 直接读取和 RPC 超时处理 ([10f953f7](https://github.com/ljquan/aitu/commit/10f953f7))
- docs: 添加同步数据格式一致性规则 ([ebb412d1](https://github.com/ljquan/aitu/commit/ebb412d1))
- docs: 添加同步模块日志规范 ([97332dc7](https://github.com/ljquan/aitu/commit/97332dc7))
- docs(claude): 添加新规则 - GitHub Gist API 批量上传大小限制 ([4e2741c9](https://github.com/ljquan/aitu/commit/4e2741c9))
- docs: 添加异步操作和事件订阅相关规则 ([a95ddd20](https://github.com/ljquan/aitu/commit/a95ddd20))
- docs: 添加 CSS 变量优先级和弹出菜单截断规则 ([8ecc8e75](https://github.com/ljquan/aitu/commit/8ecc8e75))
- docs: 添加数据安全保护编码规则 ([8a955248](https://github.com/ljquan/aitu/commit/8a955248))
- docs: 添加 SW 任务持久化规则和敏感 ID 脱敏说明 ([da0c37e1](https://github.com/ljquan/aitu/commit/da0c37e1))
- refactor(task-queue): deduplicate completed tasks and improve preview handling ([5a3b4a95](https://github.com/ljquan/aitu/commit/5a3b4a95))
- docs: 添加 SW 重发 Tool Request 延迟规则 ([fbfd0f13](https://github.com/ljquan/aitu/commit/fbfd0f13))
- docs: 更新 postmessage-duplex 规则 (v1.1.0) ([a91afda0](https://github.com/ljquan/aitu/commit/a91afda0))
- docs: 添加 postmessage-duplex 消息大小限制规则 ([597181eb](https://github.com/ljquan/aitu/commit/597181eb))
- docs: 添加 postmessage-duplex publish 模式规则 ([cac87cf4](https://github.com/ljquan/aitu/commit/cac87cf4))
- docs: 添加 postmessage-duplex 库使用规范 ([cacf6b43](https://github.com/ljquan/aitu/commit/cacf6b43))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liangyufeng <l.yfeng@qq.com>
- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.94 (2026-02-09)

### 🚀 Features

- 优化PPT相关能力 ([7f592465](https://github.com/ljquan/aitu/commit/7f592465))
- 添加套索选择工具及工具栏/命令面板集成 ([0d5e1d82](https://github.com/ljquan/aitu/commit/0d5e1d82))
- 添加 Frame 和幻灯片播放功能 ([c9859671](https://github.com/ljquan/aitu/commit/c9859671))
- implement new canvas features and command palette ([47dfcf12](https://github.com/ljquan/aitu/commit/47dfcf12))
- enhance logging and error handling in WorkflowEngine ([5074339b](https://github.com/ljquan/aitu/commit/5074339b))
- improve fallback engine handling and logging in workflow submission service ([88a7199e](https://github.com/ljquan/aitu/commit/88a7199e))
- add batch clear failed tasks button in generation task list ([e303baf8](https://github.com/ljquan/aitu/commit/e303baf8))
- enhance logging and error handling in AI analysis and agent execution ([cc03ce1c](https://github.com/ljquan/aitu/commit/cc03ce1c))
- enhance session replay management and error handling ([8a190371](https://github.com/ljquan/aitu/commit/8a190371))
- improve Service Worker channel validation for streaming API calls ([8f81e6ef](https://github.com/ljquan/aitu/commit/8f81e6ef))
- unify Service Worker availability checks and enforce main thread executor in fallback scenarios ([e27d14e0](https://github.com/ljquan/aitu/commit/e27d14e0))
- enhance workflow submission and error handling ([3365fdfc](https://github.com/ljquan/aitu/commit/3365fdfc))
- optimize analytics reporting and payload management ([fef7bf06](https://github.com/ljquan/aitu/commit/fef7bf06))

### 🩹 Fixes

- 修复tab 同步问题 ([7c390191](https://github.com/ljquan/aitu/commit/7c390191))
- 视频任务状态 ([ea3c2ccc](https://github.com/ljquan/aitu/commit/ea3c2ccc))
- update DelegatedOperation type usage in workflow submission service ([ac40be77](https://github.com/ljquan/aitu/commit/ac40be77))
- guard video model config lookups ([16473751](https://github.com/ljquan/aitu/commit/16473751))
- 降级模式图片/视频带参考图与 1MB 限制 ([66db4935](https://github.com/ljquan/aitu/commit/66db4935))
- 修复视频 API 请求格式错误 ([0262697f](https://github.com/ljquan/aitu/commit/0262697f))

### 🔧 Chores

- bump version to 0.5.93 ([3f6e583c](https://github.com/ljquan/aitu/commit/3f6e583c))
- bump version to 0.5.92 ([c32b257c](https://github.com/ljquan/aitu/commit/c32b257c))
- bump version to 0.5.91 ([13442303](https://github.com/ljquan/aitu/commit/13442303))
- bump version to 0.5.90 ([773cdb08](https://github.com/ljquan/aitu/commit/773cdb08))
- 更新应用版本至 0.5.89 ([8ff11e56](https://github.com/ljquan/aitu/commit/8ff11e56))
- bump version to 0.5.89 ([85635880](https://github.com/ljquan/aitu/commit/85635880))
- update version to 0.5.88 and improve task storage handling ([1adae49f](https://github.com/ljquan/aitu/commit/1adae49f))
- bump version to 0.5.88 ([af685dde](https://github.com/ljquan/aitu/commit/af685dde))
- bump version to 0.5.87 ([de16ae04](https://github.com/ljquan/aitu/commit/de16ae04))
- bump version to 0.5.86 ([2394021b](https://github.com/ljquan/aitu/commit/2394021b))
- bump version to 0.5.85 ([8e45567e](https://github.com/ljquan/aitu/commit/8e45567e))
- bump version to 0.5.84 ([1aea9496](https://github.com/ljquan/aitu/commit/1aea9496))
- bump version to 0.5.83 ([322118fb](https://github.com/ljquan/aitu/commit/322118fb))
- bump version to 0.5.82 ([692f0eff](https://github.com/ljquan/aitu/commit/692f0eff))
- update version to 0.5.82 and adjust build time ([87a5198d](https://github.com/ljquan/aitu/commit/87a5198d))
- bump version to 0.5.81 ([3ab8846d](https://github.com/ljquan/aitu/commit/3ab8846d))
- update app version to 0.5.80 and adjust build time ([dbdb729b](https://github.com/ljquan/aitu/commit/dbdb729b))
- bump version to 0.5.80 ([e8b67aee](https://github.com/ljquan/aitu/commit/e8b67aee))
- bump version to 0.5.79 ([b175bfaf](https://github.com/ljquan/aitu/commit/b175bfaf))
- update postmessage-duplex dependency to version 1.2.0 ([2bea89d7](https://github.com/ljquan/aitu/commit/2bea89d7))
- enhance project configuration and task management ([643e69fa](https://github.com/ljquan/aitu/commit/643e69fa))
- update app version to 0.5.78 and adjust styles for mobile badge display ([afaf093b](https://github.com/ljquan/aitu/commit/afaf093b))
- ppt ([98a60a56](https://github.com/ljquan/aitu/commit/98a60a56))
- fix：任务状态不同步 ([8689c846](https://github.com/ljquan/aitu/commit/8689c846))
- docs(claude): 添加新规则 - RxJS事件对象引用导致React.memo失效、API错误字段类型安全 ([d553d884](https://github.com/ljquan/aitu/commit/d553d884))
- docs(claude): 添加新规则 - 数值范围转换规则、列表索引ID追踪 ([fbb91726](https://github.com/ljquan/aitu/commit/fbb91726))
- refactor: remove unused SW RPC methods and optimize communication ([e36bbc76](https://github.com/ljquan/aitu/commit/e36bbc76))
- docs(claude): 添加新规则 - 编程式选中元素需用 addSelectionWithTemporaryElements 触发渲染 ([a2b0cd01](https://github.com/ljquan/aitu/commit/a2b0cd01))
- docs(claude): 添加新规则 - 自定义 Plait 组件 onContextChanged 必须处理 viewport 变化 ([bfad96d5](https://github.com/ljquan/aitu/commit/bfad96d5))
- docs(claude): 更新规则 - 全屏展示画布局部内容改用 viewport+隐藏UI+蒙层挖洞方案 ([e09e0e80](https://github.com/ljquan/aitu/commit/e09e0e80))
- docs(claude): 添加新规则 - 全屏展示画布局部内容用 toImage 截图独立渲染 ([649c02bf](https://github.com/ljquan/aitu/commit/649c02bf))
- docs(claude): 添加新规则 - Plait Board Viewport 缩放+平移用 updateViewport 一步完成 ([643cc38d](https://github.com/ljquan/aitu/commit/643cc38d))
- fixed:本次修改解决了ai生成图片中点击提示的下拉框手机端溢出问题&agent生成长方形图片容器溢出问题 ([64c4da2d](https://github.com/ljquan/aitu/commit/64c4da2d))
- docs(claude): 添加新规则 - 模块迁移接口完整性 ([afb95640](https://github.com/ljquan/aitu/commit/afb95640))
- docs: 添加编码规则 - 统计上报旁路化 ([133b6a72](https://github.com/ljquan/aitu/commit/133b6a72))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- liangyufeng <l.yfeng@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.91 (2026-02-08)

### 🩹 Fixes

- 视频任务状态 ([ea3c2ccc](https://github.com/ljquan/aitu/commit/ea3c2ccc))

### 🔧 Chores

- docs(claude): 添加新规则 - 数值范围转换规则、列表索引ID追踪 ([fbb91726](https://github.com/ljquan/aitu/commit/fbb91726))
- refactor: remove unused SW RPC methods and optimize communication ([e36bbc76](https://github.com/ljquan/aitu/commit/e36bbc76))
- fixed:本次修改解决了ai生成图片中点击提示的下拉框手机端溢出问题&agent生成长方形图片容器溢出问题 ([64c4da2d](https://github.com/ljquan/aitu/commit/64c4da2d))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liangyufeng <l.yfeng@qq.com>

## 0.5.90 (2026-02-08)

### 🚀 Features

- 添加套索选择工具及工具栏/命令面板集成 ([0d5e1d82](https://github.com/ljquan/aitu/commit/0d5e1d82))

### 🔧 Chores

- 更新应用版本至 0.5.89 ([8ff11e56](https://github.com/ljquan/aitu/commit/8ff11e56))
- docs(claude): 添加新规则 - 编程式选中元素需用 addSelectionWithTemporaryElements 触发渲染 ([a2b0cd01](https://github.com/ljquan/aitu/commit/a2b0cd01))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.89 (2026-02-08)

### 🚀 Features

- 添加 Frame 和幻灯片播放功能 ([c9859671](https://github.com/ljquan/aitu/commit/c9859671))
- implement new canvas features and command palette ([47dfcf12](https://github.com/ljquan/aitu/commit/47dfcf12))

### 🔧 Chores

- update version to 0.5.88 and improve task storage handling ([1adae49f](https://github.com/ljquan/aitu/commit/1adae49f))
- docs(claude): 添加新规则 - 自定义 Plait 组件 onContextChanged 必须处理 viewport 变化 ([bfad96d5](https://github.com/ljquan/aitu/commit/bfad96d5))
- docs(claude): 更新规则 - 全屏展示画布局部内容改用 viewport+隐藏UI+蒙层挖洞方案 ([e09e0e80](https://github.com/ljquan/aitu/commit/e09e0e80))
- docs(claude): 添加新规则 - 全屏展示画布局部内容用 toImage 截图独立渲染 ([649c02bf](https://github.com/ljquan/aitu/commit/649c02bf))
- docs(claude): 添加新规则 - Plait Board Viewport 缩放+平移用 updateViewport 一步完成 ([643cc38d](https://github.com/ljquan/aitu/commit/643cc38d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.87 (2026-02-07)

### 🚀 Features

- enhance logging and error handling in WorkflowEngine ([5074339b](https://github.com/ljquan/aitu/commit/5074339b))

### 🔧 Chores

- bump version to 0.5.86 ([2394021b](https://github.com/ljquan/aitu/commit/2394021b))
- bump version to 0.5.85 ([8e45567e](https://github.com/ljquan/aitu/commit/8e45567e))
- bump version to 0.5.84 ([1aea9496](https://github.com/ljquan/aitu/commit/1aea9496))
- docs(claude): 添加新规则 - 模块迁移接口完整性 ([afb95640](https://github.com/ljquan/aitu/commit/afb95640))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.86 (2026-02-07)

### 🚀 Features

- improve fallback engine handling and logging in workflow submission service ([88a7199e](https://github.com/ljquan/aitu/commit/88a7199e))

### 🩹 Fixes

- update DelegatedOperation type usage in workflow submission service ([ac40be77](https://github.com/ljquan/aitu/commit/ac40be77))

### 🔧 Chores

- bump version to 0.5.85 ([694d1ca6](https://github.com/ljquan/aitu/commit/694d1ca6))
- bump version to 0.5.84 ([9e307468](https://github.com/ljquan/aitu/commit/9e307468))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.85 (2026-02-07)

### 🚀 Features

- add batch clear failed tasks button in generation task list ([e303baf8](https://github.com/ljquan/aitu/commit/e303baf8))

### 🩹 Fixes

- guard video model config lookups ([16473751](https://github.com/ljquan/aitu/commit/16473751))
- 修复视频 API 请求格式错误 ([0262697f](https://github.com/ljquan/aitu/commit/0262697f))

### 🔧 Chores

- bump version to 0.5.84 ([fd194ee7](https://github.com/ljquan/aitu/commit/fd194ee7))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liangyufeng <l.yfeng@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.84 (2026-02-07)

### 🔧 Chores

- update version to 0.5.82 and adjust build time ([87a5198d](https://github.com/ljquan/aitu/commit/87a5198d))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.83 (2026-02-07)

### 🚀 Features

- enhance logging and error handling in AI analysis and agent execution ([cc03ce1c](https://github.com/ljquan/aitu/commit/cc03ce1c))

### 🔧 Chores

- bump version to 0.5.82 ([692f0eff](https://github.com/ljquan/aitu/commit/692f0eff))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.82 (2026-02-07)

### 🚀 Features

- enhance session replay management and error handling ([8a190371](https://github.com/ljquan/aitu/commit/8a190371))
- improve Service Worker channel validation for streaming API calls ([8f81e6ef](https://github.com/ljquan/aitu/commit/8f81e6ef))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.81 (2026-02-07)

### 🚀 Features

- unify Service Worker availability checks and enforce main thread executor in fallback scenarios ([e27d14e0](https://github.com/ljquan/aitu/commit/e27d14e0))
- enhance workflow submission and error handling ([3365fdfc](https://github.com/ljquan/aitu/commit/3365fdfc))

### 🔧 Chores

- update app version to 0.5.80 and adjust build time ([dbdb729b](https://github.com/ljquan/aitu/commit/dbdb729b))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.79 (2026-02-06)

### 🚀 Features

- optimize analytics reporting and payload management ([fef7bf06](https://github.com/ljquan/aitu/commit/fef7bf06))
- add custom tools sync and prevent remote task resumption ([f296875d](https://github.com/ljquan/aitu/commit/f296875d))
- implement workflow handler initialization from IndexedDB ([943419ec](https://github.com/ljquan/aitu/commit/943419ec))
- enhance error handling and logging in Service Worker and task management ([167a559a](https://github.com/ljquan/aitu/commit/167a559a))
- implement video model adapters and enhance video generation ([982313f3](https://github.com/ljquan/aitu/commit/982313f3))
- enhance SW task queue service with fallback mechanisms and canvas operation handling ([390bb155](https://github.com/ljquan/aitu/commit/390bb155))
- add base64 image preview functionality ([fba4fe7f](https://github.com/ljquan/aitu/commit/fba4fe7f))
- implement image fitting utility and enhance video processing ([25746d6b](https://github.com/ljquan/aitu/commit/25746d6b))

### 🩹 Fixes

- 降级模式图片/视频带参考图与 1MB 限制 ([66db4935](https://github.com/ljquan/aitu/commit/66db4935))
- add missing apiKey to videoConfig in SW initialization ([a1971c4e](https://github.com/ljquan/aitu/commit/a1971c4e))

### 🔧 Chores

- update postmessage-duplex dependency to version 1.2.0 ([2bea89d7](https://github.com/ljquan/aitu/commit/2bea89d7))
- enhance project configuration and task management ([643e69fa](https://github.com/ljquan/aitu/commit/643e69fa))
- update app version to 0.5.78 and adjust styles for mobile badge display ([afaf093b](https://github.com/ljquan/aitu/commit/afaf093b))
- bump version to 0.5.78 ([b0f3df9e](https://github.com/ljquan/aitu/commit/b0f3df9e))
- update version to 0.5.77 and adjust build time ([f11329fe](https://github.com/ljquan/aitu/commit/f11329fe))
- bump version to 0.5.77 ([e158b459](https://github.com/ljquan/aitu/commit/e158b459))
- bump version to 0.5.76 ([22ef45ad](https://github.com/ljquan/aitu/commit/22ef45ad))
- bump version to 0.5.75 ([4a0e9128](https://github.com/ljquan/aitu/commit/4a0e9128))
- update version to 0.5.74 and adjust build time ([c7eb7979](https://github.com/ljquan/aitu/commit/c7eb7979))
- bump version to 0.5.74 ([1fc59675](https://github.com/ljquan/aitu/commit/1fc59675))
- update version to 0.5.73 and improve task loading logic ([99b268e6](https://github.com/ljquan/aitu/commit/99b268e6))
- bump version to 0.5.73 ([06a61e81](https://github.com/ljquan/aitu/commit/06a61e81))
- update version to 0.5.72 and enhance LLM API logging ([3cdc13ea](https://github.com/ljquan/aitu/commit/3cdc13ea))
- bump version to 0.5.72 ([df013d28](https://github.com/ljquan/aitu/commit/df013d28))
- update app version to 0.5.71 and adjust build time ([504fee1c](https://github.com/ljquan/aitu/commit/504fee1c))
- docs: 添加编码规则 - 统计上报旁路化 ([133b6a72](https://github.com/ljquan/aitu/commit/133b6a72))
- docs: update localhost port references from 4200 to 7200 ([5a10c4c4](https://github.com/ljquan/aitu/commit/5a10c4c4))
- docs: 添加编码规则 - 配置同步到 IndexedDB 供 SW 读取 ([db99fb6d](https://github.com/ljquan/aitu/commit/db99fb6d))
- docs: 添加编码规则 - 枚举不能使用 import type 导入 ([26360e85](https://github.com/ljquan/aitu/commit/26360e85))
- 简化方案 ([12525090](https://github.com/ljquan/aitu/commit/12525090))
- refactor: simplify architecture by removing DDD layers and unifying types ([ad341a4f](https://github.com/ljquan/aitu/commit/ad341a4f))
- docs: 添加配置对象深拷贝规则 ([0002654a](https://github.com/ljquan/aitu/commit/0002654a))
- perf: 优化同步上传性能，避免 UI 阻塞 ([cbe11e08](https://github.com/ljquan/aitu/commit/cbe11e08))
- docs: 添加 LLM API 日志记录异步任务 remoteId 规则 ([708131f7](https://github.com/ljquan/aitu/commit/708131f7))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.78 (2026-02-06)

### 🚀 Features

- add custom tools sync and prevent remote task resumption ([f296875](https://github.com/ljquan/aitu/commit/f296875))
- implement workflow handler initialization from IndexedDB ([943419e](https://github.com/ljquan/aitu/commit/943419e))
- enhance error handling and logging in Service Worker and task management ([167a559](https://github.com/ljquan/aitu/commit/167a559))
- implement video model adapters and enhance video generation ([982313f](https://github.com/ljquan/aitu/commit/982313f))
- enhance SW task queue service with fallback mechanisms and canvas operation handling ([390bb15](https://github.com/ljquan/aitu/commit/390bb15))
- add base64 image preview functionality ([fba4fe7](https://github.com/ljquan/aitu/commit/fba4fe7))

### 🩹 Fixes

- add missing apiKey to videoConfig in SW initialization ([a1971c4](https://github.com/ljquan/aitu/commit/a1971c4))

### 🔧 Chores

- update version to 0.5.77 and adjust build time ([f11329f](https://github.com/ljquan/aitu/commit/f11329f))
- bump version to 0.5.77 ([e158b45](https://github.com/ljquan/aitu/commit/e158b45))
- bump version to 0.5.76 ([22ef45a](https://github.com/ljquan/aitu/commit/22ef45a))
- bump version to 0.5.75 ([4a0e912](https://github.com/ljquan/aitu/commit/4a0e912))
- update version to 0.5.74 and adjust build time ([c7eb797](https://github.com/ljquan/aitu/commit/c7eb797))
- docs: update localhost port references from 4200 to 7200 ([5a10c4c](https://github.com/ljquan/aitu/commit/5a10c4c))
- docs: 添加编码规则 - 配置同步到 IndexedDB 供 SW 读取 ([db99fb6](https://github.com/ljquan/aitu/commit/db99fb6))
- docs: 添加编码规则 - 枚举不能使用 import type 导入 ([26360e8](https://github.com/ljquan/aitu/commit/26360e8))
- 简化方案 ([1252509](https://github.com/ljquan/aitu/commit/1252509))
- refactor: simplify architecture by removing DDD layers and unifying types ([ad341a4](https://github.com/ljquan/aitu/commit/ad341a4))
- docs: 添加配置对象深拷贝规则 ([0002654](https://github.com/ljquan/aitu/commit/0002654))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.76 (2026-02-05)

### 🚀 Features

- add base64 image preview functionality ([fba4fe7](https://github.com/ljquan/aitu/commit/fba4fe7))

### 🔧 Chores

- docs: 添加配置对象深拷贝规则 ([0002654](https://github.com/ljquan/aitu/commit/0002654))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.75 (2026-02-05)

### 🚀 Features

- implement image fitting utility and enhance video processing ([25746d6](https://github.com/ljquan/aitu/commit/25746d6))
- enhance analytics and reporting functionality ([30a9bbf](https://github.com/ljquan/aitu/commit/30a9bbf))
- enhance video handling and task queue management ([4757a0d](https://github.com/ljquan/aitu/commit/4757a0d))
- add master badge and enhance Gist handling ([1dc71a9](https://github.com/ljquan/aitu/commit/1dc71a9))
- implement failed URL caching for external image requests ([4376be0](https://github.com/ljquan/aitu/commit/4376be0))
- integrate fake-indexeddb and refactor media executor ([dae0bb8](https://github.com/ljquan/aitu/commit/dae0bb8))
- implement unified media execution and workflow enhancements ([900db04](https://github.com/ljquan/aitu/commit/900db04))
- add Gist management panel and enhance sync logging ([061423a](https://github.com/ljquan/aitu/commit/061423a))
- implement soft delete and data recovery features ([3a93bf0](https://github.com/ljquan/aitu/commit/3a93bf0))
- 任务队列同步下载远程数据时双向合并 ([27064a5](https://github.com/ljquan/aitu/commit/27064a5))
- implement deletion sync with recycle bin ([a36176b](https://github.com/ljquan/aitu/commit/a36176b))
- implement data encryption and synchronization enhancements ([c0518af](https://github.com/ljquan/aitu/commit/c0518af))
- enhance thumbnail request handling with parameter prioritization ([8b0b95b](https://github.com/ljquan/aitu/commit/8b0b95b))
- support opening tools via URL parameter and display tool icons in window title ([9abfb3f](https://github.com/ljquan/aitu/commit/9abfb3f))
- enhance board ID management via URL parameters and improve user interaction ([738f8b9](https://github.com/ljquan/aitu/commit/738f8b9))
- 改进工作流恢复机制和错误处理 ([d27939f](https://github.com/ljquan/aitu/commit/d27939f))
- move ai_analyze to SW and improve debug panel logging ([50c9405](https://github.com/ljquan/aitu/commit/50c9405))
- implement LLM API log selection and batch actions ([070801c](https://github.com/ljquan/aitu/commit/070801c))

### 🩹 Fixes

- enhance workflow submission with timeout and retry logic ([84e9436](https://github.com/ljquan/aitu/commit/84e9436))
- enhance manifest decryption error handling ([163bcee](https://github.com/ljquan/aitu/commit/163bcee))
- initialize session model from global settings ([24ec69f](https://github.com/ljquan/aitu/commit/24ec69f))

### 🔧 Chores

- update version to 0.5.74 and adjust build time ([c7eb797](https://github.com/ljquan/aitu/commit/c7eb797))
- bump version to 0.5.74 ([1fc5967](https://github.com/ljquan/aitu/commit/1fc5967))
- update version to 0.5.73 and improve task loading logic ([99b268e](https://github.com/ljquan/aitu/commit/99b268e))
- bump version to 0.5.73 ([06a61e8](https://github.com/ljquan/aitu/commit/06a61e8))
- update version to 0.5.72 and enhance LLM API logging ([3cdc13e](https://github.com/ljquan/aitu/commit/3cdc13e))
- bump version to 0.5.72 ([df013d2](https://github.com/ljquan/aitu/commit/df013d2))
- update app version to 0.5.71 and adjust build time ([504fee1](https://github.com/ljquan/aitu/commit/504fee1))
- bump version to 0.5.71 ([65d6716](https://github.com/ljquan/aitu/commit/65d6716))
- bump version to 0.5.70 ([9847d77](https://github.com/ljquan/aitu/commit/9847d77))
- update build time and refactor imports for consistency ([036cce5](https://github.com/ljquan/aitu/commit/036cce5))
- update app version to 0.5.69 and adjust build time in version.json ([af1fb11](https://github.com/ljquan/aitu/commit/af1fb11))
- bump version to 0.5.69 ([f51c14c](https://github.com/ljquan/aitu/commit/f51c14c))
- bump version to 0.5.68 ([49329c4](https://github.com/ljquan/aitu/commit/49329c4))
- update app version to 0.5.67 and adjust build time ([fedfebd](https://github.com/ljquan/aitu/commit/fedfebd))
- bump version to 0.5.67 ([70486b7](https://github.com/ljquan/aitu/commit/70486b7))
- bump version to 0.5.66 ([d0eafd6](https://github.com/ljquan/aitu/commit/d0eafd6))
- clean up debug console logs and fix winbox icon handling ([21a6666](https://github.com/ljquan/aitu/commit/21a6666))
- update version and build time, refine toolbar styles, and ensure consistent type exports ([4b3a784](https://github.com/ljquan/aitu/commit/4b3a784))
- update app version to 0.5.64 and adjust build time ([1772d5c](https://github.com/ljquan/aitu/commit/1772d5c))
- perf: 优化同步上传性能，避免 UI 阻塞 ([cbe11e0](https://github.com/ljquan/aitu/commit/cbe11e0))
- docs: 添加 LLM API 日志记录异步任务 remoteId 规则 ([708131f](https://github.com/ljquan/aitu/commit/708131f))
- docs: 添加编码规则 - SW 初始化统一入口 ([f13f809](https://github.com/ljquan/aitu/commit/f13f809))
- docs: 添加编码规则 - 模块循环依赖处理 ([e6a39db](https://github.com/ljquan/aitu/commit/e6a39db))
- docs: 添加降级模式任务执行规则 ([e0f459a](https://github.com/ljquan/aitu/commit/e0f459a))
- refactor: 清理调试日志和未使用代码 ([066eb12](https://github.com/ljquan/aitu/commit/066eb12))
- docs: 更新工具函数规则 - 添加新模块和避免不必要包装 ([8dfcf4a](https://github.com/ljquan/aitu/commit/8dfcf4a))
- docs: 添加编码规则 - 降级路径功能一致性 ([5c86d02](https://github.com/ljquan/aitu/commit/5c86d02))
- docs: 添加 LLM 响应格式兼容性和工作流状态同步规则 ([3d844c4](https://github.com/ljquan/aitu/commit/3d844c4))
- docs: 添加编码规则 - IndexedDB 直接读取和 RPC 超时处理 ([10f953f](https://github.com/ljquan/aitu/commit/10f953f))
- docs: 添加同步数据格式一致性规则 ([ebb412d](https://github.com/ljquan/aitu/commit/ebb412d))
- docs: 添加同步模块日志规范 ([97332dc](https://github.com/ljquan/aitu/commit/97332dc))
- docs(claude): 添加新规则 - GitHub Gist API 批量上传大小限制 ([4e2741c](https://github.com/ljquan/aitu/commit/4e2741c))
- docs: 添加异步操作和事件订阅相关规则 ([a95ddd2](https://github.com/ljquan/aitu/commit/a95ddd2))
- docs: 添加 CSS 变量优先级和弹出菜单截断规则 ([8ecc8e7](https://github.com/ljquan/aitu/commit/8ecc8e7))
- docs: 添加数据安全保护编码规则 ([8a95524](https://github.com/ljquan/aitu/commit/8a95524))
- docs: 添加 SW 任务持久化规则和敏感 ID 脱敏说明 ([da0c37e](https://github.com/ljquan/aitu/commit/da0c37e))
- refactor(task-queue): deduplicate completed tasks and improve preview handling ([5a3b4a9](https://github.com/ljquan/aitu/commit/5a3b4a9))
- docs: 添加 SW 重发 Tool Request 延迟规则 ([fbfd0f1](https://github.com/ljquan/aitu/commit/fbfd0f1))
- docs: 更新 postmessage-duplex 规则 (v1.1.0) ([a91afda](https://github.com/ljquan/aitu/commit/a91afda))
- docs: 添加 postmessage-duplex 消息大小限制规则 ([597181e](https://github.com/ljquan/aitu/commit/597181e))
- docs: 添加 postmessage-duplex publish 模式规则 ([cac87cf](https://github.com/ljquan/aitu/commit/cac87cf))
- docs: 添加 postmessage-duplex 库使用规范 ([cacf6b4](https://github.com/ljquan/aitu/commit/cacf6b4))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.74 (2026-02-05)

### 🔧 Chores

- update version to 0.5.73 and improve task loading logic ([99b268e](https://github.com/ljquan/aitu/commit/99b268e))
- perf: 优化同步上传性能，避免 UI 阻塞 ([cbe11e0](https://github.com/ljquan/aitu/commit/cbe11e0))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.73 (2026-02-05)

### 🚀 Features

- implement image fitting utility and enhance video processing ([25746d6](https://github.com/ljquan/aitu/commit/25746d6))

### 🔧 Chores

- update version to 0.5.72 and enhance LLM API logging ([3cdc13e](https://github.com/ljquan/aitu/commit/3cdc13e))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.72 (2026-02-05)

### 🚀 Features

- enhance analytics and reporting functionality ([30a9bbf](https://github.com/ljquan/aitu/commit/30a9bbf))
- enhance video handling and task queue management ([4757a0d](https://github.com/ljquan/aitu/commit/4757a0d))
- add master badge and enhance Gist handling ([1dc71a9](https://github.com/ljquan/aitu/commit/1dc71a9))
- implement failed URL caching for external image requests ([4376be0](https://github.com/ljquan/aitu/commit/4376be0))

### 🔧 Chores

- update app version to 0.5.71 and adjust build time ([504fee1](https://github.com/ljquan/aitu/commit/504fee1))
- bump version to 0.5.71 ([65d6716](https://github.com/ljquan/aitu/commit/65d6716))
- docs: 添加 LLM API 日志记录异步任务 remoteId 规则 ([708131f](https://github.com/ljquan/aitu/commit/708131f))
- docs: 添加编码规则 - SW 初始化统一入口 ([f13f809](https://github.com/ljquan/aitu/commit/f13f809))
- docs: 添加编码规则 - 模块循环依赖处理 ([e6a39db](https://github.com/ljquan/aitu/commit/e6a39db))
- docs: 添加降级模式任务执行规则 ([e0f459a](https://github.com/ljquan/aitu/commit/e0f459a))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.71 (2026-02-05)

### 🚀 Features

- enhance analytics and reporting functionality ([30a9bbfd](https://github.com/ljquan/aitu/commit/30a9bbfd))
- enhance video handling and task queue management ([4757a0d4](https://github.com/ljquan/aitu/commit/4757a0d4))
- add master badge and enhance Gist handling ([1dc71a99](https://github.com/ljquan/aitu/commit/1dc71a99))
- implement failed URL caching for external image requests ([4376be0c](https://github.com/ljquan/aitu/commit/4376be0c))
- integrate fake-indexeddb and refactor media executor ([dae0bb8a](https://github.com/ljquan/aitu/commit/dae0bb8a))
- implement unified media execution and workflow enhancements ([900db04d](https://github.com/ljquan/aitu/commit/900db04d))
- add Gist management panel and enhance sync logging ([061423a9](https://github.com/ljquan/aitu/commit/061423a9))

### 🩹 Fixes

- enhance workflow submission with timeout and retry logic ([84e9436c](https://github.com/ljquan/aitu/commit/84e9436c))

### 🔧 Chores

- bump version to 0.5.70 ([9847d773](https://github.com/ljquan/aitu/commit/9847d773))
- update build time and refactor imports for consistency ([036cce52](https://github.com/ljquan/aitu/commit/036cce52))
- update app version to 0.5.69 and adjust build time in version.json ([af1fb113](https://github.com/ljquan/aitu/commit/af1fb113))
- bump version to 0.5.69 ([f51c14c0](https://github.com/ljquan/aitu/commit/f51c14c0))
- docs: 添加编码规则 - SW 初始化统一入口 ([f13f809a](https://github.com/ljquan/aitu/commit/f13f809a))
- docs: 添加编码规则 - 模块循环依赖处理 ([e6a39db6](https://github.com/ljquan/aitu/commit/e6a39db6))
- docs: 添加降级模式任务执行规则 ([e0f459a6](https://github.com/ljquan/aitu/commit/e0f459a6))
- refactor: 清理调试日志和未使用代码 ([066eb12d](https://github.com/ljquan/aitu/commit/066eb12d))
- docs: 更新工具函数规则 - 添加新模块和避免不必要包装 ([8dfcf4a3](https://github.com/ljquan/aitu/commit/8dfcf4a3))
- docs: 添加编码规则 - 降级路径功能一致性 ([5c86d02b](https://github.com/ljquan/aitu/commit/5c86d02b))
- docs: 添加 LLM 响应格式兼容性和工作流状态同步规则 ([3d844c42](https://github.com/ljquan/aitu/commit/3d844c42))
- docs: 添加编码规则 - IndexedDB 直接读取和 RPC 超时处理 ([10f953f7](https://github.com/ljquan/aitu/commit/10f953f7))
- docs: 添加同步数据格式一致性规则 ([ebb412d1](https://github.com/ljquan/aitu/commit/ebb412d1))
- docs: 添加同步模块日志规范 ([97332dc7](https://github.com/ljquan/aitu/commit/97332dc7))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.70 (2026-02-04)

### 🚀 Features

- integrate fake-indexeddb and refactor media executor ([dae0bb8](https://github.com/ljquan/aitu/commit/dae0bb8))

### 🔧 Chores

- update build time and refactor imports for consistency ([036cce5](https://github.com/ljquan/aitu/commit/036cce5))
- update app version to 0.5.69 and adjust build time in version.json ([af1fb11](https://github.com/ljquan/aitu/commit/af1fb11))
- refactor: 清理调试日志和未使用代码 ([066eb12](https://github.com/ljquan/aitu/commit/066eb12))
- docs: 更新工具函数规则 - 添加新模块和避免不必要包装 ([8dfcf4a](https://github.com/ljquan/aitu/commit/8dfcf4a))
- docs: 添加编码规则 - 降级路径功能一致性 ([5c86d02](https://github.com/ljquan/aitu/commit/5c86d02))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.69 (2026-02-04)

### 🚀 Features

- implement unified media execution and workflow enhancements ([900db04](https://github.com/ljquan/aitu/commit/900db04))
- add Gist management panel and enhance sync logging ([061423a](https://github.com/ljquan/aitu/commit/061423a))
- implement soft delete and data recovery features ([3a93bf0](https://github.com/ljquan/aitu/commit/3a93bf0))
- 任务队列同步下载远程数据时双向合并 ([27064a5](https://github.com/ljquan/aitu/commit/27064a5))
- implement deletion sync with recycle bin ([a36176b](https://github.com/ljquan/aitu/commit/a36176b))
- implement data encryption and synchronization enhancements ([c0518af](https://github.com/ljquan/aitu/commit/c0518af))
- enhance thumbnail request handling with parameter prioritization ([8b0b95b](https://github.com/ljquan/aitu/commit/8b0b95b))
- support opening tools via URL parameter and display tool icons in window title ([9abfb3f](https://github.com/ljquan/aitu/commit/9abfb3f))
- enhance board ID management via URL parameters and improve user interaction ([738f8b9](https://github.com/ljquan/aitu/commit/738f8b9))
- 改进工作流恢复机制和错误处理 ([d27939f](https://github.com/ljquan/aitu/commit/d27939f))
- move ai_analyze to SW and improve debug panel logging ([50c9405](https://github.com/ljquan/aitu/commit/50c9405))
- implement LLM API log selection and batch actions ([070801c](https://github.com/ljquan/aitu/commit/070801c))
- support async models with size and references ([e85dda8](https://github.com/ljquan/aitu/commit/e85dda8))
- implement auto-compression for 10-25MB images ([c26cbec](https://github.com/ljquan/aitu/commit/c26cbec))

### 🩹 Fixes

- enhance workflow submission with timeout and retry logic ([84e9436](https://github.com/ljquan/aitu/commit/84e9436))
- enhance manifest decryption error handling ([163bcee](https://github.com/ljquan/aitu/commit/163bcee))
- initialize session model from global settings ([24ec69f](https://github.com/ljquan/aitu/commit/24ec69f))

### 🔧 Chores

- bump version to 0.5.68 ([49329c4](https://github.com/ljquan/aitu/commit/49329c4))
- update app version to 0.5.67 and adjust build time ([fedfebd](https://github.com/ljquan/aitu/commit/fedfebd))
- bump version to 0.5.67 ([70486b7](https://github.com/ljquan/aitu/commit/70486b7))
- bump version to 0.5.66 ([d0eafd6](https://github.com/ljquan/aitu/commit/d0eafd6))
- clean up debug console logs and fix winbox icon handling ([21a6666](https://github.com/ljquan/aitu/commit/21a6666))
- update version and build time, refine toolbar styles, and ensure consistent type exports ([4b3a784](https://github.com/ljquan/aitu/commit/4b3a784))
- update app version to 0.5.64 and adjust build time ([1772d5c](https://github.com/ljquan/aitu/commit/1772d5c))
- bump version to 0.5.64 ([c820a82](https://github.com/ljquan/aitu/commit/c820a82))
- update release script and bump app version to 0.5.63 ([8b36e88](https://github.com/ljquan/aitu/commit/8b36e88))
- docs: 添加 LLM 响应格式兼容性和工作流状态同步规则 ([3d844c4](https://github.com/ljquan/aitu/commit/3d844c4))
- docs: 添加编码规则 - IndexedDB 直接读取和 RPC 超时处理 ([10f953f](https://github.com/ljquan/aitu/commit/10f953f))
- docs: 添加同步数据格式一致性规则 ([ebb412d](https://github.com/ljquan/aitu/commit/ebb412d))
- docs: 添加同步模块日志规范 ([97332dc](https://github.com/ljquan/aitu/commit/97332dc))
- docs(claude): 添加新规则 - GitHub Gist API 批量上传大小限制 ([4e2741c](https://github.com/ljquan/aitu/commit/4e2741c))
- docs: 添加异步操作和事件订阅相关规则 ([a95ddd2](https://github.com/ljquan/aitu/commit/a95ddd2))
- docs: 添加 CSS 变量优先级和弹出菜单截断规则 ([8ecc8e7](https://github.com/ljquan/aitu/commit/8ecc8e7))
- docs: 添加数据安全保护编码规则 ([8a95524](https://github.com/ljquan/aitu/commit/8a95524))
- docs: 添加 SW 任务持久化规则和敏感 ID 脱敏说明 ([da0c37e](https://github.com/ljquan/aitu/commit/da0c37e))
- refactor(task-queue): deduplicate completed tasks and improve preview handling ([5a3b4a9](https://github.com/ljquan/aitu/commit/5a3b4a9))
- docs: 添加 SW 重发 Tool Request 延迟规则 ([fbfd0f1](https://github.com/ljquan/aitu/commit/fbfd0f1))
- docs: 更新 postmessage-duplex 规则 (v1.1.0) ([a91afda](https://github.com/ljquan/aitu/commit/a91afda))
- docs: 添加 postmessage-duplex 消息大小限制规则 ([597181e](https://github.com/ljquan/aitu/commit/597181e))
- docs: 添加 postmessage-duplex publish 模式规则 ([cac87cf](https://github.com/ljquan/aitu/commit/cac87cf))
- docs: 添加 postmessage-duplex 库使用规范 ([cacf6b4](https://github.com/ljquan/aitu/commit/cacf6b4))
- refactor: rename project from Aitu to Yue画布 ([a4ca6ca](https://github.com/ljquan/aitu/commit/a4ca6ca))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- mengxiangtu <changesydneyai@gmail.com>

## 0.5.68 (2026-02-02)

### 🩹 Fixes

- enhance manifest decryption error handling ([163bcee](https://github.com/ljquan/aitu/commit/163bcee))

### 🔧 Chores

- update app version to 0.5.67 and adjust build time ([fedfebd](https://github.com/ljquan/aitu/commit/fedfebd))
- docs(claude): 添加新规则 - GitHub Gist API 批量上传大小限制 ([4e2741c](https://github.com/ljquan/aitu/commit/4e2741c))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.67 (2026-02-02)

### 🚀 Features

- implement soft delete and data recovery features ([3a93bf0](https://github.com/ljquan/aitu/commit/3a93bf0))
- 任务队列同步下载远程数据时双向合并 ([27064a5](https://github.com/ljquan/aitu/commit/27064a5))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.64 (2026-01-30)

### 🚀 Features

- support async models with size and references ([e85dda8](https://github.com/ljquan/aitu/commit/e85dda8))
- implement auto-compression for 10-25MB images ([c26cbec](https://github.com/ljquan/aitu/commit/c26cbec))
- 添加"不再提示"按钮到灵感创意板块 ([17b926a](https://github.com/ljquan/aitu/commit/17b926a))
- 添加重命名验证功能，禁止同级重名 ([a69c57a](https://github.com/ljquan/aitu/commit/a69c57a))
- 完成 AI 输入栏和 ChatDrawer 完整测试体系 ([1c3fa39](https://github.com/ljquan/aitu/commit/1c3fa39))
- 完成所有核心功能 Manual GIF 录制体系 ([d60c4a4](https://github.com/ljquan/aitu/commit/d60c4a4))

### 🔧 Chores

- update release script and bump app version to 0.5.63 ([8b36e88](https://github.com/ljquan/aitu/commit/8b36e88))
- bump version to 0.5.63 ([52f4493](https://github.com/ljquan/aitu/commit/52f4493))
- update app version to 0.5.62 and adjust build time in version.json ([147815c](https://github.com/ljquan/aitu/commit/147815c))
- bump version to 0.5.62 ([15c42c6](https://github.com/ljquan/aitu/commit/15c42c6))
- update version to 0.5.61 and enhance batch processing logic in image and video generation ([243725e](https://github.com/ljquan/aitu/commit/243725e))
- refactor: rename project from Aitu to Yue画布 ([a4ca6ca](https://github.com/ljquan/aitu/commit/a4ca6ca))
- refactor: 迁移通用工具函数到 @aitu/utils 并消除二次导出 ([0645497](https://github.com/ljquan/aitu/commit/0645497))
- docs: 添加工具函数组织规则 ([6abdcad](https://github.com/ljquan/aitu/commit/6abdcad))
- Remove legacy workspace rename spec ([a7063f4](https://github.com/ljquan/aitu/commit/a7063f4))
- Fix workspace item naming collisions ([b8019f1](https://github.com/ljquan/aitu/commit/b8019f1))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- mengxiangtu <changesydneyai@gmail.com>
- liquidliang <ljquan@qq.com>
- zzz <zzz@zzzdeMac-mini.local>

## 0.5.63 (2026-01-29)

### 🚀 Features

- 添加"不再提示"按钮到灵感创意板块 ([17b926a](https://github.com/ljquan/aitu/commit/17b926a))

### 🔧 Chores

- update app version to 0.5.62 and adjust build time in version.json ([147815c](https://github.com/ljquan/aitu/commit/147815c))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- zzz <zzz@zzzdeMac-mini.local>

## 0.5.62 (2026-01-29)

### 🚀 Features

- 添加重命名验证功能，禁止同级重名 ([a69c57a](https://github.com/ljquan/aitu/commit/a69c57a))
- 完成 AI 输入栏和 ChatDrawer 完整测试体系 ([1c3fa39](https://github.com/ljquan/aitu/commit/1c3fa39))
- 完成所有核心功能 Manual GIF 录制体系 ([d60c4a4](https://github.com/ljquan/aitu/commit/d60c4a4))
- 移动端适配 ([ade6470](https://github.com/ljquan/aitu/commit/ade6470))
- 全面优化多端响应式适配 ([1b06d2f](https://github.com/ljquan/aitu/commit/1b06d2f))
- 统一媒体预览组件并优化缩略图展示 ([a617211](https://github.com/ljquan/aitu/commit/a617211))
- enhance pencil and eraser settings with shape selection ([cbde7b2](https://github.com/ljquan/aitu/commit/cbde7b2))
- 增强文字属性面板样式设置功能 ([2b437fa](https://github.com/ljquan/aitu/commit/2b437fa))
- add alignment, distribution, and boolean operation buttons ([811111e](https://github.com/ljquan/aitu/commit/811111e))
- 对比模式下视频联动同步播放和重置 ([ea9b932](https://github.com/ljquan/aitu/commit/ea9b932))
- enhance user manual generation and CDN integration ([ba4746d](https://github.com/ljquan/aitu/commit/ba4746d))
- enhance user manual generation and E2E testing ([607ec7e](https://github.com/ljquan/aitu/commit/607ec7e))
- 添加用户手册生成系统和 E2E 测试增强 ([4daff77](https://github.com/ljquan/aitu/commit/4daff77))
- 新增 TaskProgressOverlay 组件显示任务进度 ([0ab1aa3](https://github.com/ljquan/aitu/commit/0ab1aa3))

### 🩹 Fixes

- 修复批量生成只执行第一个任务的问题 ([ebca700](https://github.com/ljquan/aitu/commit/ebca700))
- enhance task submission and execution checks ([7a92d70](https://github.com/ljquan/aitu/commit/7a92d70))
- 使用 Context 共享健康状态数据修复显示不一致问题 ([b95247a](https://github.com/ljquan/aitu/commit/b95247a))

### 🔧 Chores

- update version to 0.5.61 and enhance batch processing logic in image and video generation ([243725e](https://github.com/ljquan/aitu/commit/243725e))
- bump version to 0.5.61 ([20feb2d](https://github.com/ljquan/aitu/commit/20feb2d))
- update version to 0.5.60 and improve board selection logic ([3723135](https://github.com/ljquan/aitu/commit/3723135))
- bump version to 0.5.60 ([9d64bc7](https://github.com/ljquan/aitu/commit/9d64bc7))
- bump version to 0.5.59 ([8b93fb2](https://github.com/ljquan/aitu/commit/8b93fb2))
- remove batch-image.html from build and deploy configurations ([7ef1c37](https://github.com/ljquan/aitu/commit/7ef1c37))
- update deployment scripts and versioning logic; bump version to 0.5.58 ([f7c1cde](https://github.com/ljquan/aitu/commit/f7c1cde))
- bump version to 0.5.58 ([80fb213](https://github.com/ljquan/aitu/commit/80fb213))
- bump version to 0.5.57 ([8aff14b](https://github.com/ljquan/aitu/commit/8aff14b))
- bump version to 0.5.56 ([34917aa](https://github.com/ljquan/aitu/commit/34917aa))
- bump version to 0.5.55 ([41eb428](https://github.com/ljquan/aitu/commit/41eb428))
- bump version to 0.5.54 ([c5e23b0](https://github.com/ljquan/aitu/commit/c5e23b0))
- bump version to 0.5.53 ([c49a324](https://github.com/ljquan/aitu/commit/c49a324))
- bump version to 0.5.52 ([bc42ff4](https://github.com/ljquan/aitu/commit/bc42ff4))
- bump version to 0.5.51 ([78acdbf](https://github.com/ljquan/aitu/commit/78acdbf))
- bump version to 0.5.50 ([c5db0c5](https://github.com/ljquan/aitu/commit/c5db0c5))
- bump version to 0.5.49 ([396f90c](https://github.com/ljquan/aitu/commit/396f90c))
- update app version to 0.5.48 and adjust build time ([b97371b](https://github.com/ljquan/aitu/commit/b97371b))
- refactor: 迁移通用工具函数到 @aitu/utils 并消除二次导出 ([0645497](https://github.com/ljquan/aitu/commit/0645497))
- docs: 添加工具函数组织规则 ([6abdcad](https://github.com/ljquan/aitu/commit/6abdcad))
- Remove legacy workspace rename spec ([a7063f4](https://github.com/ljquan/aitu/commit/a7063f4))
- Fix workspace item naming collisions ([b8019f1](https://github.com/ljquan/aitu/commit/b8019f1))
- docs(claude): 添加新规则 - 工作区初始化自动选择画板 ([c571cb7](https://github.com/ljquan/aitu/commit/c571cb7))
- refactor(task-queue): update resume methods to reuse original LLM API log entries ([d96f066](https://github.com/ljquan/aitu/commit/d96f066))
- 去掉参数n ([989e919](https://github.com/ljquan/aitu/commit/989e919))
- docs: 添加 Slate-React Leaf DOM 结构稳定性规则 ([a20c4a4](https://github.com/ljquan/aitu/commit/a20c4a4))
- docs: 添加编码规则 - Clipper 布尔运算结果处理 ([fe13ef8](https://github.com/ljquan/aitu/commit/fe13ef8))
- docs: 添加编码规则 - useCallback 定义顺序 ([6f891ea](https://github.com/ljquan/aitu/commit/6f891ea))
- docs(claude): 添加新规则 - 日志记录应反映实际发送的数据 ([c714761](https://github.com/ljquan/aitu/commit/c714761))
- docs(claude): 添加新规则 - 多组件共享异步数据时使用 Context ([c688c15](https://github.com/ljquan/aitu/commit/c688c15))
- docs(claude): 添加新规则 - Props 变化时重置组件内部状态 ([2011c2e](https://github.com/ljquan/aitu/commit/2011c2e))
- docs(claude): 添加新规则 - Flex布局兄弟元素隐藏导致宽度变化 ([9a917ab](https://github.com/ljquan/aitu/commit/9a917ab))
- Update README.md ([cf65ccf](https://github.com/ljquan/aitu/commit/cf65ccf))
- Update README_en.md ([aa6986d](https://github.com/ljquan/aitu/commit/aa6986d))
- docs(readme): align Chinese link ([3d37033](https://github.com/ljquan/aitu/commit/3d37033))
- docs(readme): fix english readme link ([c58b01d](https://github.com/ljquan/aitu/commit/c58b01d))
- docs(readme): update demo links ([4fd7ba4](https://github.com/ljquan/aitu/commit/4fd7ba4))
- 添加e2e ([07e18e2](https://github.com/ljquan/aitu/commit/07e18e2))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>
- ovst <wangjueszu@qq.com>

## 0.5.61 (2026-01-27)

### 🚀 Features

- 移动端适配 ([ade6470](https://github.com/ljquan/aitu/commit/ade6470))
- 全面优化多端响应式适配 ([1b06d2f](https://github.com/ljquan/aitu/commit/1b06d2f))
- 统一媒体预览组件并优化缩略图展示 ([a617211](https://github.com/ljquan/aitu/commit/a617211))
- enhance pencil and eraser settings with shape selection ([cbde7b2](https://github.com/ljquan/aitu/commit/cbde7b2))
- 增强文字属性面板样式设置功能 ([2b437fa](https://github.com/ljquan/aitu/commit/2b437fa))
- add alignment, distribution, and boolean operation buttons ([811111e](https://github.com/ljquan/aitu/commit/811111e))
- 对比模式下视频联动同步播放和重置 ([ea9b932](https://github.com/ljquan/aitu/commit/ea9b932))
- enhance user manual generation and CDN integration ([ba4746d](https://github.com/ljquan/aitu/commit/ba4746d))
- enhance user manual generation and E2E testing ([607ec7e](https://github.com/ljquan/aitu/commit/607ec7e))
- 添加用户手册生成系统和 E2E 测试增强 ([4daff77](https://github.com/ljquan/aitu/commit/4daff77))
- 新增 TaskProgressOverlay 组件显示任务进度 ([0ab1aa3](https://github.com/ljquan/aitu/commit/0ab1aa3))

### 🩹 Fixes

- 修复批量生成只执行第一个任务的问题 ([ebca700](https://github.com/ljquan/aitu/commit/ebca700))
- enhance task submission and execution checks ([7a92d70](https://github.com/ljquan/aitu/commit/7a92d70))
- 使用 Context 共享健康状态数据修复显示不一致问题 ([b95247a](https://github.com/ljquan/aitu/commit/b95247a))

### 🔧 Chores

- update version to 0.5.60 and improve board selection logic ([3723135](https://github.com/ljquan/aitu/commit/3723135))
- bump version to 0.5.60 ([9d64bc7](https://github.com/ljquan/aitu/commit/9d64bc7))
- bump version to 0.5.59 ([8b93fb2](https://github.com/ljquan/aitu/commit/8b93fb2))
- remove batch-image.html from build and deploy configurations ([7ef1c37](https://github.com/ljquan/aitu/commit/7ef1c37))
- update deployment scripts and versioning logic; bump version to 0.5.58 ([f7c1cde](https://github.com/ljquan/aitu/commit/f7c1cde))
- bump version to 0.5.58 ([80fb213](https://github.com/ljquan/aitu/commit/80fb213))
- bump version to 0.5.57 ([8aff14b](https://github.com/ljquan/aitu/commit/8aff14b))
- bump version to 0.5.56 ([34917aa](https://github.com/ljquan/aitu/commit/34917aa))
- bump version to 0.5.55 ([41eb428](https://github.com/ljquan/aitu/commit/41eb428))
- bump version to 0.5.54 ([c5e23b0](https://github.com/ljquan/aitu/commit/c5e23b0))
- bump version to 0.5.53 ([c49a324](https://github.com/ljquan/aitu/commit/c49a324))
- bump version to 0.5.52 ([bc42ff4](https://github.com/ljquan/aitu/commit/bc42ff4))
- bump version to 0.5.51 ([78acdbf](https://github.com/ljquan/aitu/commit/78acdbf))
- bump version to 0.5.50 ([c5db0c5](https://github.com/ljquan/aitu/commit/c5db0c5))
- bump version to 0.5.49 ([396f90c](https://github.com/ljquan/aitu/commit/396f90c))
- update app version to 0.5.48 and adjust build time ([b97371b](https://github.com/ljquan/aitu/commit/b97371b))
- docs(claude): 添加新规则 - 工作区初始化自动选择画板 ([c571cb7](https://github.com/ljquan/aitu/commit/c571cb7))
- refactor(task-queue): update resume methods to reuse original LLM API log entries ([d96f066](https://github.com/ljquan/aitu/commit/d96f066))
- 去掉参数n ([989e919](https://github.com/ljquan/aitu/commit/989e919))
- docs: 添加 Slate-React Leaf DOM 结构稳定性规则 ([a20c4a4](https://github.com/ljquan/aitu/commit/a20c4a4))
- docs: 添加编码规则 - Clipper 布尔运算结果处理 ([fe13ef8](https://github.com/ljquan/aitu/commit/fe13ef8))
- docs: 添加编码规则 - useCallback 定义顺序 ([6f891ea](https://github.com/ljquan/aitu/commit/6f891ea))
- docs(claude): 添加新规则 - 日志记录应反映实际发送的数据 ([c714761](https://github.com/ljquan/aitu/commit/c714761))
- docs(claude): 添加新规则 - 多组件共享异步数据时使用 Context ([c688c15](https://github.com/ljquan/aitu/commit/c688c15))
- docs(claude): 添加新规则 - Props 变化时重置组件内部状态 ([2011c2e](https://github.com/ljquan/aitu/commit/2011c2e))
- docs(claude): 添加新规则 - Flex布局兄弟元素隐藏导致宽度变化 ([9a917ab](https://github.com/ljquan/aitu/commit/9a917ab))
- Update README.md ([cf65ccf](https://github.com/ljquan/aitu/commit/cf65ccf))
- Update README_en.md ([aa6986d](https://github.com/ljquan/aitu/commit/aa6986d))
- docs(readme): align Chinese link ([3d37033](https://github.com/ljquan/aitu/commit/3d37033))
- docs(readme): fix english readme link ([c58b01d](https://github.com/ljquan/aitu/commit/c58b01d))
- docs(readme): update demo links ([4fd7ba4](https://github.com/ljquan/aitu/commit/4fd7ba4))
- 添加e2e ([07e18e2](https://github.com/ljquan/aitu/commit/07e18e2))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- ovst <wangjueszu@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.60 (2026-01-26)

### 🔧 Chores

- docs(claude): 添加新规则 - 工作区初始化自动选择画板 ([9bece83](https://github.com/ljquan/aitu/commit/9bece83))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.59 (2026-01-26)

### 🚀 Features

- 移动端适配 ([ade6470](https://github.com/ljquan/aitu/commit/ade6470))

### 🔧 Chores

- update deployment scripts and versioning logic; bump version to 0.5.58 ([f7c1cde](https://github.com/ljquan/aitu/commit/f7c1cde))
- bump version to 0.5.58 ([80fb213](https://github.com/ljquan/aitu/commit/80fb213))
- bump version to 0.5.57 ([8aff14b](https://github.com/ljquan/aitu/commit/8aff14b))
- bump version to 0.5.56 ([34917aa](https://github.com/ljquan/aitu/commit/34917aa))
- bump version to 0.5.55 ([41eb428](https://github.com/ljquan/aitu/commit/41eb428))
- bump version to 0.5.54 ([c5e23b0](https://github.com/ljquan/aitu/commit/c5e23b0))
- bump version to 0.5.53 ([c49a324](https://github.com/ljquan/aitu/commit/c49a324))
- bump version to 0.5.52 ([bc42ff4](https://github.com/ljquan/aitu/commit/bc42ff4))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.52 (2026-01-26)

### 🚀 Features

- 移动端适配 ([ade6470](https://github.com/ljquan/aitu/commit/ade6470))
- 全面优化多端响应式适配 ([1b06d2f](https://github.com/ljquan/aitu/commit/1b06d2f))
- 统一媒体预览组件并优化缩略图展示 ([a617211](https://github.com/ljquan/aitu/commit/a617211))
- enhance pencil and eraser settings with shape selection ([cbde7b2](https://github.com/ljquan/aitu/commit/cbde7b2))
- 增强文字属性面板样式设置功能 ([2b437fa](https://github.com/ljquan/aitu/commit/2b437fa))
- add alignment, distribution, and boolean operation buttons ([811111e](https://github.com/ljquan/aitu/commit/811111e))
- 对比模式下视频联动同步播放和重置 ([ea9b932](https://github.com/ljquan/aitu/commit/ea9b932))
- enhance user manual generation and CDN integration ([ba4746d](https://github.com/ljquan/aitu/commit/ba4746d))
- enhance user manual generation and E2E testing ([607ec7e](https://github.com/ljquan/aitu/commit/607ec7e))
- 添加用户手册生成系统和 E2E 测试增强 ([4daff77](https://github.com/ljquan/aitu/commit/4daff77))
- 新增 TaskProgressOverlay 组件显示任务进度 ([0ab1aa3](https://github.com/ljquan/aitu/commit/0ab1aa3))

### 🩹 Fixes

- 修复批量生成只执行第一个任务的问题 ([ebca700](https://github.com/ljquan/aitu/commit/ebca700))
- enhance task submission and execution checks ([7a92d70](https://github.com/ljquan/aitu/commit/7a92d70))
- 使用 Context 共享健康状态数据修复显示不一致问题 ([b95247a](https://github.com/ljquan/aitu/commit/b95247a))

### 🔧 Chores

- bump version to 0.5.51 ([78acdbf](https://github.com/ljquan/aitu/commit/78acdbf))
- bump version to 0.5.50 ([c5db0c5](https://github.com/ljquan/aitu/commit/c5db0c5))
- bump version to 0.5.49 ([396f90c](https://github.com/ljquan/aitu/commit/396f90c))
- update app version to 0.5.48 and adjust build time ([b97371b](https://github.com/ljquan/aitu/commit/b97371b))
- refactor(task-queue): update resume methods to reuse original LLM API log entries ([d96f066](https://github.com/ljquan/aitu/commit/d96f066))
- 去掉参数n ([989e919](https://github.com/ljquan/aitu/commit/989e919))
- docs: 添加 Slate-React Leaf DOM 结构稳定性规则 ([a20c4a4](https://github.com/ljquan/aitu/commit/a20c4a4))
- docs: 添加编码规则 - Clipper 布尔运算结果处理 ([fe13ef8](https://github.com/ljquan/aitu/commit/fe13ef8))
- docs: 添加编码规则 - useCallback 定义顺序 ([6f891ea](https://github.com/ljquan/aitu/commit/6f891ea))
- docs(claude): 添加新规则 - 日志记录应反映实际发送的数据 ([c714761](https://github.com/ljquan/aitu/commit/c714761))
- docs(claude): 添加新规则 - 多组件共享异步数据时使用 Context ([c688c15](https://github.com/ljquan/aitu/commit/c688c15))
- docs(claude): 添加新规则 - Props 变化时重置组件内部状态 ([2011c2e](https://github.com/ljquan/aitu/commit/2011c2e))
- docs(claude): 添加新规则 - Flex布局兄弟元素隐藏导致宽度变化 ([9a917ab](https://github.com/ljquan/aitu/commit/9a917ab))
- Update README.md ([cf65ccf](https://github.com/ljquan/aitu/commit/cf65ccf))
- Update README_en.md ([aa6986d](https://github.com/ljquan/aitu/commit/aa6986d))
- docs(readme): align Chinese link ([3d37033](https://github.com/ljquan/aitu/commit/3d37033))
- docs(readme): fix english readme link ([c58b01d](https://github.com/ljquan/aitu/commit/c58b01d))
- docs(readme): update demo links ([4fd7ba4](https://github.com/ljquan/aitu/commit/4fd7ba4))
- 添加e2e ([07e18e2](https://github.com/ljquan/aitu/commit/07e18e2))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- ovst <wangjueszu@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.51 (2026-01-25)

### 🚀 Features

- 全面优化多端响应式适配 ([1b06d2f](https://github.com/ljquan/aitu/commit/1b06d2f))
- 统一媒体预览组件并优化缩略图展示 ([a617211](https://github.com/ljquan/aitu/commit/a617211))
- enhance pencil and eraser settings with shape selection ([cbde7b2](https://github.com/ljquan/aitu/commit/cbde7b2))
- 增强文字属性面板样式设置功能 ([2b437fa](https://github.com/ljquan/aitu/commit/2b437fa))
- add alignment, distribution, and boolean operation buttons ([811111e](https://github.com/ljquan/aitu/commit/811111e))

### 🩹 Fixes

- enhance task submission and execution checks ([7a92d70](https://github.com/ljquan/aitu/commit/7a92d70))

### 🔧 Chores

- 去掉参数n ([989e919](https://github.com/ljquan/aitu/commit/989e919))
- docs: 添加 Slate-React Leaf DOM 结构稳定性规则 ([a20c4a4](https://github.com/ljquan/aitu/commit/a20c4a4))
- docs: 添加编码规则 - Clipper 布尔运算结果处理 ([fe13ef8](https://github.com/ljquan/aitu/commit/fe13ef8))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.50 (2026-01-24)

### 🚀 Features

- 对比模式下视频联动同步播放和重置 ([ea9b932](https://github.com/ljquan/aitu/commit/ea9b932))

### 🔧 Chores

- docs: 添加编码规则 - useCallback 定义顺序 ([6f891ea](https://github.com/ljquan/aitu/commit/6f891ea))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.49 (2026-01-24)

### 🚀 Features

- enhance user manual generation and CDN integration ([ba4746d](https://github.com/ljquan/aitu/commit/ba4746d))
- enhance user manual generation and E2E testing ([607ec7e](https://github.com/ljquan/aitu/commit/607ec7e))
- 添加用户手册生成系统和 E2E 测试增强 ([4daff77](https://github.com/ljquan/aitu/commit/4daff77))
- 新增 TaskProgressOverlay 组件显示任务进度 ([0ab1aa3](https://github.com/ljquan/aitu/commit/0ab1aa3))

### 🩹 Fixes

- 使用 Context 共享健康状态数据修复显示不一致问题 ([b95247a](https://github.com/ljquan/aitu/commit/b95247a))

### 🔧 Chores

- update app version to 0.5.48 and adjust build time ([b97371b](https://github.com/ljquan/aitu/commit/b97371b))
- docs(claude): 添加新规则 - 日志记录应反映实际发送的数据 ([c714761](https://github.com/ljquan/aitu/commit/c714761))
- docs(claude): 添加新规则 - 多组件共享异步数据时使用 Context ([c688c15](https://github.com/ljquan/aitu/commit/c688c15))
- docs(claude): 添加新规则 - Props 变化时重置组件内部状态 ([2011c2e](https://github.com/ljquan/aitu/commit/2011c2e))
- docs(claude): 添加新规则 - Flex布局兄弟元素隐藏导致宽度变化 ([9a917ab](https://github.com/ljquan/aitu/commit/9a917ab))
- Update README.md ([cf65ccf](https://github.com/ljquan/aitu/commit/cf65ccf))
- Update README_en.md ([aa6986d](https://github.com/ljquan/aitu/commit/aa6986d))
- docs(readme): align Chinese link ([3d37033](https://github.com/ljquan/aitu/commit/3d37033))
- docs(readme): fix english readme link ([c58b01d](https://github.com/ljquan/aitu/commit/c58b01d))
- docs(readme): update demo links ([4fd7ba4](https://github.com/ljquan/aitu/commit/4fd7ba4))
- 添加e2e ([07e18e2](https://github.com/ljquan/aitu/commit/07e18e2))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- ovst <wangjueszu@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.44 (2026-01-23)

### 🔧 Chores

- update app version to 0.5.43 and adjust build time ([f0f1d52](https://github.com/ljquan/aitu/commit/f0f1d52))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.43 (2026-01-23)

### 🚀 Features

- 点击画板自动关闭项目抽屉和工具箱抽屉 ([a91ed12](https://github.com/ljquan/aitu/commit/a91ed12))
- update Yue画布 labels and model hints ([8571c79](https://github.com/ljquan/aitu/commit/8571c79))

### 🩹 Fixes

- 修复图片覆盖保存时缩放比例计算错误 ([81a59ba](https://github.com/ljquan/aitu/commit/81a59ba))

### 🔧 Chores

- update app version to 0.5.42 and adjust build time ([14e6185](https://github.com/ljquan/aitu/commit/14e6185))
- bump version to 0.5.1 ([7fadafd](https://github.com/ljquan/aitu/commit/7fadafd))
- style(settings-dialog): 美化设置弹窗并统一模型选择器样式 ([e7c30ce](https://github.com/ljquan/aitu/commit/e7c30ce))
- refactor(image-editor): 提取图片尺寸计算逻辑到共享模块 ([596faab](https://github.com/ljquan/aitu/commit/596faab))
- docs: 添加编码规则 - 模式切换状态同步 ([db19940](https://github.com/ljquan/aitu/commit/db19940))
- Update online experience link in README ([b3a8b4c](https://github.com/ljquan/aitu/commit/b3a8b4c))
- Update README.md ([339e720](https://github.com/ljquan/aitu/commit/339e720))
- Rename project to Yue画布 and update README ([38032e6](https://github.com/ljquan/aitu/commit/38032e6))
- 添加readme 的 git 图素材 ([c0bb49a](https://github.com/ljquan/aitu/commit/c0bb49a))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- Yue画布 Developer <noreply@aitu.chat>
- gongchengtu <1817063960@qq.com>
- ovst <wangjueszu@qq.com>

## 0.5.42 (2026-01-23)

### 🚀 Features

- update AI input parser to enhance prompt generation logic ([272d73d](https://github.com/ljquan/aitu/commit/272d73d))
- 优化分析模式 ([60bf02a](https://github.com/ljquan/aitu/commit/60bf02a))
- 添加数据备份功能和进度显示 ([cc74d29](https://github.com/ljquan/aitu/commit/cc74d29))
- 统一 Tooltip 样式并美化模型健康状态信号展示 ([1076cb2](https://github.com/ljquan/aitu/commit/1076cb2))
- 初始化时自动滚动显示 AI 按钮 ([f110657](https://github.com/ljquan/aitu/commit/f110657))
- 优化角色创建时间轴视频帧显示 ([2a927bc](https://github.com/ljquan/aitu/commit/2a927bc))
- 添加工具窗口最小化/恢复动画 ([0cba6b1](https://github.com/ljquan/aitu/commit/0cba6b1))
- 优化工具箱 UI 和工具栏交互 ([b866b85](https://github.com/ljquan/aitu/commit/b866b85))
- 增强敏感信息处理和日志记录 ([70c83b6](https://github.com/ljquan/aitu/commit/70c83b6))
- add media library button and functionality to AI input bar ([3ece148](https://github.com/ljquan/aitu/commit/3ece148))
- 优化素材库筛选按钮间距并实现三段式循环排序模式 ([1264b42](https://github.com/ljquan/aitu/commit/1264b42))

### 🩹 Fixes

- 阻止无效配置下创建的任务被执行 ([fae807b](https://github.com/ljquan/aitu/commit/fae807b))
- 修复多选元素时填充色图标显示异常 ([bbfeaaa](https://github.com/ljquan/aitu/commit/bbfeaaa))
- 修复视频插入函数名错误 ([9593b02](https://github.com/ljquan/aitu/commit/9593b02))

### 🔧 Chores

- 清理调试日志和修复未定义函数调用 ([718c4fb](https://github.com/ljquan/aitu/commit/718c4fb))
- update app version to 0.5.41 and adjust build time ([0fc7aeb](https://github.com/ljquan/aitu/commit/0fc7aeb))
- bump version to 0.5.41 ([7b3ffc0](https://github.com/ljquan/aitu/commit/7b3ffc0))
- bump version to 0.5.40 ([d78e75c](https://github.com/ljquan/aitu/commit/d78e75c))
- bump version to 0.5.39 ([1fa11f9](https://github.com/ljquan/aitu/commit/1fa11f9))
- bump version to 0.5.39 ([95ab336](https://github.com/ljquan/aitu/commit/95ab336))
- update app version to 0.5.38 and adjust build time in version.json ([47d1029](https://github.com/ljquan/aitu/commit/47d1029))
- bump version to 0.5.38 ([ee623df](https://github.com/ljquan/aitu/commit/ee623df))
- bump version to 0.5.36 ([ab4d3e2](https://github.com/ljquan/aitu/commit/ab4d3e2))
- update app version to 0.5.37 and enhance tool URL handling ([fba900c](https://github.com/ljquan/aitu/commit/fba900c))
- docs: 精简 CLAUDE.md 并补充编码规则 ([2ca7cc9](https://github.com/ljquan/aitu/commit/2ca7cc9))
- refactor(image-splitter): 提取共享模块统一拆分配置 ([10816e8](https://github.com/ljquan/aitu/commit/10816e8))
- docs: 添加共享模块设计规则 ([53d0900](https://github.com/ljquan/aitu/commit/53d0900))
- refactor(health): 使用单例控制模型健康状态 API 调用频率 ([cfb92dd](https://github.com/ljquan/aitu/commit/cfb92dd))
- docs(claude): 添加新规则 - 无效配置下的数据不应被持久化或执行 ([5bfa029](https://github.com/ljquan/aitu/commit/5bfa029))
- docs: 添加编码规则 - 布局抖动、结构化数据与图标验证 ([27dedea](https://github.com/ljquan/aitu/commit/27dedea))
- style(winbox): optimize titlebar buttons for light theme and fix black square issue ([0a45250](https://github.com/ljquan/aitu/commit/0a45250))
- refactor(sw-debug): 模块化重构调试面板 ([33aa2ed](https://github.com/ljquan/aitu/commit/33aa2ed))
- refactor(auto-complete-shape-picker): update shape icons to use JSX syntax ([5049f6e](https://github.com/ljquan/aitu/commit/5049f6e))
- docs: 添加 SW 枚举值小写规则 ([dceb83a](https://github.com/ljquan/aitu/commit/dceb83a))
- docs(rules): 添加 Blob MIME 类型获取和 Shift 连选防文本选中规则 ([c0e63d0](https://github.com/ljquan/aitu/commit/c0e63d0))
- docs(claude): 添加新规则 - 同名模块的全局状态隔离问题 ([3d92dda](https://github.com/ljquan/aitu/commit/3d92dda))
- docs: 添加 UI 交互规范 - 可点击容器、筛选联动、全局配色 ([1d8c77c](https://github.com/ljquan/aitu/commit/1d8c77c))
- docs: 添加强制重绘 void 前缀规则 ([98b400f](https://github.com/ljquan/aitu/commit/98b400f))
- docs: 添加 TDesign Dropdown popupProps 透传规则 ([14925fb](https://github.com/ljquan/aitu/commit/14925fb))
- docs: 更新项目文档，修正在线应用链接并优化 CLAUDE.md 结构 ([dfef8c1](https://github.com/ljquan/aitu/commit/dfef8c1))
- docs(claude): 添加项目概念文档和维护规则 ([70fddff](https://github.com/ljquan/aitu/commit/70fddff))
- docs(claude): 添加敏感信息过滤相关安全规则 ([1156efc](https://github.com/ljquan/aitu/commit/1156efc))
- docs(claude): 添加新交互和样式规则 - 三段式排序与筛选岛对齐 ([ec72cd5](https://github.com/ljquan/aitu/commit/ec72cd5))
- docs(claude): 更新规则 - 图标组件渲染错误示例补充三元表达式场景 ([4116347](https://github.com/ljquan/aitu/commit/4116347))
- docs(claude): 添加敏感信息模板变量安全处理规则 ([a206daa](https://github.com/ljquan/aitu/commit/a206daa))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.41 (2026-01-23)

### 🚀 Features

- 优化分析模式 ([60bf02a](https://github.com/ljquan/aitu/commit/60bf02a))
- 添加数据备份功能和进度显示 ([cc74d29](https://github.com/ljquan/aitu/commit/cc74d29))
- 统一 Tooltip 样式并美化模型健康状态信号展示 ([1076cb2](https://github.com/ljquan/aitu/commit/1076cb2))
- 初始化时自动滚动显示 AI 按钮 ([f110657](https://github.com/ljquan/aitu/commit/f110657))

### 🩹 Fixes

- 修复多选元素时填充色图标显示异常 ([bbfeaaa](https://github.com/ljquan/aitu/commit/bbfeaaa))

### 🔧 Chores

- bump version to 0.5.40 ([d78e75c](https://github.com/ljquan/aitu/commit/d78e75c))
- bump version to 0.5.39 ([1fa11f9](https://github.com/ljquan/aitu/commit/1fa11f9))
- refactor(sw-debug): 模块化重构调试面板 ([33aa2ed](https://github.com/ljquan/aitu/commit/33aa2ed))
- refactor(auto-complete-shape-picker): update shape icons to use JSX syntax ([5049f6e](https://github.com/ljquan/aitu/commit/5049f6e))
- docs: 添加 SW 枚举值小写规则 ([dceb83a](https://github.com/ljquan/aitu/commit/dceb83a))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.39 (2026-01-22)

### 🚀 Features

- 添加数据备份功能和进度显示 ([cc74d29](https://github.com/ljquan/aitu/commit/cc74d29))
- 统一 Tooltip 样式并美化模型健康状态信号展示 ([1076cb2](https://github.com/ljquan/aitu/commit/1076cb2))
- 初始化时自动滚动显示 AI 按钮 ([f110657](https://github.com/ljquan/aitu/commit/f110657))
- 优化角色创建时间轴视频帧显示 ([2a927bc](https://github.com/ljquan/aitu/commit/2a927bc))
- 添加工具窗口最小化/恢复动画 ([0cba6b1](https://github.com/ljquan/aitu/commit/0cba6b1))
- 优化工具箱 UI 和工具栏交互 ([b866b85](https://github.com/ljquan/aitu/commit/b866b85))
- 增强敏感信息处理和日志记录 ([70c83b6](https://github.com/ljquan/aitu/commit/70c83b6))
- add media library button and functionality to AI input bar ([3ece148](https://github.com/ljquan/aitu/commit/3ece148))
- 优化素材库筛选按钮间距并实现三段式循环排序模式 ([1264b42](https://github.com/ljquan/aitu/commit/1264b42))
- 添加模型健康状态功能并更新 CLAUDE.md 文档 ([98f9319](https://github.com/ljquan/aitu/commit/98f9319))
- implement precache manifest generation and update service worker activation strategy ([f44fea3](https://github.com/ljquan/aitu/commit/f44fea3))
- implement responsive layout with ResizeObserver and improve styling consistency ([72057e9](https://github.com/ljquan/aitu/commit/72057e9))

### 🩹 Fixes

- 修复多选元素时填充色图标显示异常 ([bbfeaaa](https://github.com/ljquan/aitu/commit/bbfeaaa))
- 修复视频插入函数名错误 ([9593b02](https://github.com/ljquan/aitu/commit/9593b02))
- 修复 ModelDropdown Portal 模式下的位置计算和点击选择问题 ([f075058](https://github.com/ljquan/aitu/commit/f075058))

### 🔧 Chores

- update app version to 0.5.38 and adjust build time in version.json ([47d1029](https://github.com/ljquan/aitu/commit/47d1029))
- bump version to 0.5.38 ([ee623df](https://github.com/ljquan/aitu/commit/ee623df))
- bump version to 0.5.36 ([ab4d3e2](https://github.com/ljquan/aitu/commit/ab4d3e2))
- update app version to 0.5.37 and enhance tool URL handling ([fba900c](https://github.com/ljquan/aitu/commit/fba900c))
- bump version to 0.5.37 ([3a06964](https://github.com/ljquan/aitu/commit/3a06964))
- update app version to 0.5.36 and adjust build time in version.json ([b1cd461](https://github.com/ljquan/aitu/commit/b1cd461))
- bump version to 0.5.36 ([0c8c796](https://github.com/ljquan/aitu/commit/0c8c796))
- update app version to 0.5.35 and adjust build time in version.json ([7b8c32e](https://github.com/ljquan/aitu/commit/7b8c32e))
- bump version to 0.5.35 ([cfa8949](https://github.com/ljquan/aitu/commit/cfa8949))
- bump version to 0.5.34 ([2903d85](https://github.com/ljquan/aitu/commit/2903d85))
- bump version to 0.5.33 ([e9cd0ec](https://github.com/ljquan/aitu/commit/e9cd0ec))
- bump version to 0.5.32 ([f0ff19e](https://github.com/ljquan/aitu/commit/f0ff19e))
- bump version to 0.5.31 ([8d4cb2d](https://github.com/ljquan/aitu/commit/8d4cb2d))
- update app version to 0.5.30 and adjust build time in version.json ([1512fd7](https://github.com/ljquan/aitu/commit/1512fd7))
- bump version to 0.5.30 ([5279f38](https://github.com/ljquan/aitu/commit/5279f38))
- refactor(auto-complete-shape-picker): update shape icons to use JSX syntax ([5049f6e](https://github.com/ljquan/aitu/commit/5049f6e))
- docs: 添加 SW 枚举值小写规则 ([dceb83a](https://github.com/ljquan/aitu/commit/dceb83a))
- docs(rules): 添加 Blob MIME 类型获取和 Shift 连选防文本选中规则 ([c0e63d0](https://github.com/ljquan/aitu/commit/c0e63d0))
- docs(claude): 添加新规则 - 同名模块的全局状态隔离问题 ([3d92dda](https://github.com/ljquan/aitu/commit/3d92dda))
- docs: 添加 UI 交互规范 - 可点击容器、筛选联动、全局配色 ([1d8c77c](https://github.com/ljquan/aitu/commit/1d8c77c))
- docs: 添加强制重绘 void 前缀规则 ([98b400f](https://github.com/ljquan/aitu/commit/98b400f))
- docs: 添加 TDesign Dropdown popupProps 透传规则 ([14925fb](https://github.com/ljquan/aitu/commit/14925fb))
- docs: 更新项目文档，修正在线应用链接并优化 CLAUDE.md 结构 ([dfef8c1](https://github.com/ljquan/aitu/commit/dfef8c1))
- docs(claude): 添加项目概念文档和维护规则 ([70fddff](https://github.com/ljquan/aitu/commit/70fddff))
- docs(claude): 添加敏感信息过滤相关安全规则 ([1156efc](https://github.com/ljquan/aitu/commit/1156efc))
- docs(claude): 添加新交互和样式规则 - 三段式排序与筛选岛对齐 ([ec72cd5](https://github.com/ljquan/aitu/commit/ec72cd5))
- docs(claude): 更新规则 - 图标组件渲染错误示例补充三元表达式场景 ([4116347](https://github.com/ljquan/aitu/commit/4116347))
- docs(claude): 添加敏感信息模板变量安全处理规则 ([a206daa](https://github.com/ljquan/aitu/commit/a206daa))
- docs(claude): 添加关于批量操作按钮视觉层级和 URL 模板变量处理的新规则 ([1891b1e](https://github.com/ljquan/aitu/commit/1891b1e))
- docs(claude): 添加关于 Tooltip 布局、筛选逻辑和 UI 设计原则的新规则 ([d7eaca8](https://github.com/ljquan/aitu/commit/d7eaca8))
- docs(claude): 添加新规则 - 嵌套滚动容器和动态高度容器的滚动事件处理 ([7e6c26b](https://github.com/ljquan/aitu/commit/7e6c26b))
- refactor: update HandIcon SVG paths for improved structure and clarity ([1741b5a](https://github.com/ljquan/aitu/commit/1741b5a))
- docs(claude): 添加有关图标组件规范和筛选逻辑修复的新规则 ([0d35d22](https://github.com/ljquan/aitu/commit/0d35d22))
- docs(claude): 添加新规则 - CustomEvent 传递硬编码占位符问题 ([4543793](https://github.com/ljquan/aitu/commit/4543793))
- docs(claude): 添加 Service Worker 自动激活策略文档 ([a3983d7](https://github.com/ljquan/aitu/commit/a3983d7))
- docs(claude): 补充预缓存不阻塞首次访问的说明 ([d5ca154](https://github.com/ljquan/aitu/commit/d5ca154))
- docs(claude): 添加 Service Worker 预缓存机制文档 ([c26bd23](https://github.com/ljquan/aitu/commit/c26bd23))
- docs(claude): 添加新规则 - 获取第三方组件位置应使用 getBoundingClientRect() ([082f274](https://github.com/ljquan/aitu/commit/082f274))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.38 (2026-01-21)

### 🔧 Chores

- bump version to 0.5.36 ([ab4d3e2](https://github.com/ljquan/aitu/commit/ab4d3e2))
- update app version to 0.5.37 and enhance tool URL handling ([fba900c](https://github.com/ljquan/aitu/commit/fba900c))
- bump version to 0.5.37 ([3a06964](https://github.com/ljquan/aitu/commit/3a06964))
- update app version to 0.5.36 and adjust build time in version.json ([b1cd461](https://github.com/ljquan/aitu/commit/b1cd461))
- bump version to 0.5.36 ([0c8c796](https://github.com/ljquan/aitu/commit/0c8c796))
- docs(claude): 更新规则 - 图标组件渲染错误示例补充三元表达式场景 ([4116347](https://github.com/ljquan/aitu/commit/4116347))
- docs(claude): 添加敏感信息模板变量安全处理规则 ([a206daa](https://github.com/ljquan/aitu/commit/a206daa))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.37 (2026-01-21)

### 🔧 Chores

- update app version to 0.5.36 and adjust build time in version.json ([b1cd461](https://github.com/ljquan/aitu/commit/b1cd461))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.36 (2026-01-21)

### 🚀 Features

- 添加模型健康状态功能并更新 CLAUDE.md 文档 ([98f9319](https://github.com/ljquan/aitu/commit/98f9319))
- implement precache manifest generation and update service worker activation strategy ([f44fea3](https://github.com/ljquan/aitu/commit/f44fea3))
- implement responsive layout with ResizeObserver and improve styling consistency ([72057e9](https://github.com/ljquan/aitu/commit/72057e9))
- enhance split and restore functionality for WinBoxWindow ([a53c0b8](https://github.com/ljquan/aitu/commit/a53c0b8))
- 优化批量出图 UI 和交互体验 ([94e2e05](https://github.com/ljquan/aitu/commit/94e2e05))

### 🩹 Fixes

- 修复 ModelDropdown Portal 模式下的位置计算和点击选择问题 ([f075058](https://github.com/ljquan/aitu/commit/f075058))

### 🔧 Chores

- update app version to 0.5.35 and adjust build time in version.json ([7b8c32e](https://github.com/ljquan/aitu/commit/7b8c32e))
- bump version to 0.5.35 ([cfa8949](https://github.com/ljquan/aitu/commit/cfa8949))
- bump version to 0.5.34 ([2903d85](https://github.com/ljquan/aitu/commit/2903d85))
- bump version to 0.5.33 ([e9cd0ec](https://github.com/ljquan/aitu/commit/e9cd0ec))
- bump version to 0.5.32 ([f0ff19e](https://github.com/ljquan/aitu/commit/f0ff19e))
- bump version to 0.5.31 ([8d4cb2d](https://github.com/ljquan/aitu/commit/8d4cb2d))
- update app version to 0.5.30 and adjust build time in version.json ([1512fd7](https://github.com/ljquan/aitu/commit/1512fd7))
- bump version to 0.5.30 ([5279f38](https://github.com/ljquan/aitu/commit/5279f38))
- update app version to 0.5.29 and adjust build time ([4a0edf6](https://github.com/ljquan/aitu/commit/4a0edf6))
- docs(claude): 添加关于批量操作按钮视觉层级和 URL 模板变量处理的新规则 ([1891b1e](https://github.com/ljquan/aitu/commit/1891b1e))
- docs(claude): 添加关于 Tooltip 布局、筛选逻辑和 UI 设计原则的新规则 ([d7eaca8](https://github.com/ljquan/aitu/commit/d7eaca8))
- docs(claude): 添加新规则 - 嵌套滚动容器和动态高度容器的滚动事件处理 ([7e6c26b](https://github.com/ljquan/aitu/commit/7e6c26b))
- refactor: update HandIcon SVG paths for improved structure and clarity ([1741b5a](https://github.com/ljquan/aitu/commit/1741b5a))
- docs(claude): 添加有关图标组件规范和筛选逻辑修复的新规则 ([0d35d22](https://github.com/ljquan/aitu/commit/0d35d22))
- docs(claude): 添加新规则 - CustomEvent 传递硬编码占位符问题 ([4543793](https://github.com/ljquan/aitu/commit/4543793))
- docs(claude): 添加 Service Worker 自动激活策略文档 ([a3983d7](https://github.com/ljquan/aitu/commit/a3983d7))
- docs(claude): 补充预缓存不阻塞首次访问的说明 ([d5ca154](https://github.com/ljquan/aitu/commit/d5ca154))
- docs(claude): 添加 Service Worker 预缓存机制文档 ([c26bd23](https://github.com/ljquan/aitu/commit/c26bd23))
- docs(claude): 添加新规则 - 获取第三方组件位置应使用 getBoundingClientRect() ([082f274](https://github.com/ljquan/aitu/commit/082f274))
- docs(claude): 添加新规则 - 独立的 React 树缺少上下文环境 ([eac542f](https://github.com/ljquan/aitu/commit/eac542f))
- docs(claude): 添加新规则 - 传递给第三方库的回调无法获取最新 React state ([306ac42](https://github.com/ljquan/aitu/commit/306ac42))
- docs(claude): 添加新规则 - 点击外部关闭应使用全局事件监听而非透明遮罩层 ([36785f1](https://github.com/ljquan/aitu/commit/36785f1))
- docs(claude): 添加新规则 - React Context 回调中必须使用函数式更新 ([3b89eb2](https://github.com/ljquan/aitu/commit/3b89eb2))
- docs(claude): 添加异步任务重试与恢复规范 ([a7b61a0](https://github.com/ljquan/aitu/commit/a7b61a0))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.5.34 (2026-01-21)

### 🚀 Features

- implement precache manifest generation and update service worker activation strategy ([f44fea3](https://github.com/ljquan/aitu/commit/f44fea3))

### 🔧 Chores

- docs(claude): 添加 Service Worker 自动激活策略文档 ([a3983d7](https://github.com/ljquan/aitu/commit/a3983d7))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.32 (2026-01-21)

### 🔧 Chores

- docs(claude): 补充预缓存不阻塞首次访问的说明 ([d5ca154](https://github.com/ljquan/aitu/commit/d5ca154))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.31 (2026-01-21)

### 🚀 Features

- implement responsive layout with ResizeObserver and improve styling consistency ([72057e9](https://github.com/ljquan/aitu/commit/72057e9))
- enhance split and restore functionality for WinBoxWindow ([a53c0b8](https://github.com/ljquan/aitu/commit/a53c0b8))
- 优化批量出图 UI 和交互体验 ([94e2e05](https://github.com/ljquan/aitu/commit/94e2e05))

### 🩹 Fixes

- keep auto-insert aspect ratio ([1457f27](https://github.com/ljquan/aitu/commit/1457f27))
- preserve image ratio in payload ([614fc8b](https://github.com/ljquan/aitu/commit/614fc8b))

### 🔧 Chores

- update app version to 0.5.30 and adjust build time in version.json ([1512fd7](https://github.com/ljquan/aitu/commit/1512fd7))
- bump version to 0.5.30 ([5279f38](https://github.com/ljquan/aitu/commit/5279f38))
- update app version to 0.5.29 and adjust build time ([4a0edf6](https://github.com/ljquan/aitu/commit/4a0edf6))
- bump version to 0.5.29 ([9adb98a](https://github.com/ljquan/aitu/commit/9adb98a))
- bump version to 0.5.28 ([9fca109](https://github.com/ljquan/aitu/commit/9fca109))
- docs(claude): 添加 Service Worker 预缓存机制文档 ([c26bd23](https://github.com/ljquan/aitu/commit/c26bd23))
- docs(claude): 添加新规则 - 获取第三方组件位置应使用 getBoundingClientRect() ([082f274](https://github.com/ljquan/aitu/commit/082f274))
- docs(claude): 添加新规则 - 独立的 React 树缺少上下文环境 ([eac542f](https://github.com/ljquan/aitu/commit/eac542f))
- docs(claude): 添加新规则 - 传递给第三方库的回调无法获取最新 React state ([306ac42](https://github.com/ljquan/aitu/commit/306ac42))
- docs(claude): 添加新规则 - 点击外部关闭应使用全局事件监听而非透明遮罩层 ([36785f1](https://github.com/ljquan/aitu/commit/36785f1))
- docs(claude): 添加新规则 - React Context 回调中必须使用函数式更新 ([3b89eb2](https://github.com/ljquan/aitu/commit/3b89eb2))
- docs(claude): 添加异步任务重试与恢复规范 ([a7b61a0](https://github.com/ljquan/aitu/commit/a7b61a0))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.30 (2026-01-20)

### 🚀 Features

- enhance split and restore functionality for WinBoxWindow ([a53c0b8](https://github.com/ljquan/aitu/commit/a53c0b8))
- 优化批量出图 UI 和交互体验 ([94e2e05](https://github.com/ljquan/aitu/commit/94e2e05))
- add reference image handling in LLM API logs and enhance task recovery mechanisms ([c94b032](https://github.com/ljquan/aitu/commit/c94b032))
- implement model dropdown component with search functionality and update AI input bar to use # for model selection ([6aa6267](https://github.com/ljquan/aitu/commit/6aa6267))
- enhance performance panel with image count tracking and updated memory thresholds ([5ec5172](https://github.com/ljquan/aitu/commit/5ec5172))
- 优化素材库 UI 交互、缩放缓存、Grid 布局及空间效率 ([c64e4a7](https://github.com/ljquan/aitu/commit/c64e4a7))

### 🩹 Fixes

- keep auto-insert aspect ratio ([1457f27](https://github.com/ljquan/aitu/commit/1457f27))
- preserve image ratio in payload ([614fc8b](https://github.com/ljquan/aitu/commit/614fc8b))

### 🔧 Chores

- update app version to 0.5.29 and adjust build time ([4a0edf6](https://github.com/ljquan/aitu/commit/4a0edf6))
- bump version to 0.5.29 ([9adb98a](https://github.com/ljquan/aitu/commit/9adb98a))
- bump version to 0.5.28 ([9fca109](https://github.com/ljquan/aitu/commit/9fca109))
- bump version to 0.5.27 ([0b3c40b](https://github.com/ljquan/aitu/commit/0b3c40b))
- bump version to 0.5.26 ([10b2b16](https://github.com/ljquan/aitu/commit/10b2b16))
- enhance CDN response validation and update version to 0.5.25 ([155ec00](https://github.com/ljquan/aitu/commit/155ec00))
- bump version to 0.5.25 ([8bd7f30](https://github.com/ljquan/aitu/commit/8bd7f30))
- bump version to 0.5.22 ([5571d3f](https://github.com/ljquan/aitu/commit/5571d3f))
- bump version to 0.5.21 ([55ad29c](https://github.com/ljquan/aitu/commit/55ad29c))
- bump version to 0.5.20 ([8bfc191](https://github.com/ljquan/aitu/commit/8bfc191))
- bump version to 0.5.19 ([8707a5b](https://github.com/ljquan/aitu/commit/8707a5b))
- bump version to 0.5.18 ([88c0dfd](https://github.com/ljquan/aitu/commit/88c0dfd))
- bump version to 0.5.17 ([91799c9](https://github.com/ljquan/aitu/commit/91799c9))
- bump version to 0.5.17 and update build time in version.json ([51b5f3f](https://github.com/ljquan/aitu/commit/51b5f3f))
- bump version to 0.5.17 ([c41c9bd](https://github.com/ljquan/aitu/commit/c41c9bd))
- update paths for CDN compatibility and add npm publish scripts ([e4cdca4](https://github.com/ljquan/aitu/commit/e4cdca4))
- docs(claude): 添加新规则 - 独立的 React 树缺少上下文环境 ([eac542f](https://github.com/ljquan/aitu/commit/eac542f))
- docs(claude): 添加新规则 - 传递给第三方库的回调无法获取最新 React state ([306ac42](https://github.com/ljquan/aitu/commit/306ac42))
- docs(claude): 添加新规则 - 点击外部关闭应使用全局事件监听而非透明遮罩层 ([36785f1](https://github.com/ljquan/aitu/commit/36785f1))
- docs(claude): 添加新规则 - React Context 回调中必须使用函数式更新 ([3b89eb2](https://github.com/ljquan/aitu/commit/3b89eb2))
- docs(claude): 添加异步任务重试与恢复规范 ([a7b61a0](https://github.com/ljquan/aitu/commit/a7b61a0))
- docs(claude): 更新调试日志处理和命令行工具使用说明，添加后台清理任务日志记录示例 ([30cf458](https://github.com/ljquan/aitu/commit/30cf458))
- docs(claude): 添加 React 事件委托、筛选逻辑、Grid 布局及 UI 高度统一规则 ([dcabd75](https://github.com/ljquan/aitu/commit/dcabd75))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.29 (2026-01-20)

### 🚀 Features

- add reference image handling in LLM API logs and enhance task recovery mechanisms ([c94b032](https://github.com/ljquan/aitu/commit/c94b032))
- implement model dropdown component with search functionality and update AI input bar to use # for model selection ([6aa6267](https://github.com/ljquan/aitu/commit/6aa6267))
- enhance performance panel with image count tracking and updated memory thresholds ([5ec5172](https://github.com/ljquan/aitu/commit/5ec5172))

### 🩹 Fixes

- keep auto-insert aspect ratio ([1457f27](https://github.com/ljquan/aitu/commit/1457f27))
- preserve image ratio in payload ([614fc8b](https://github.com/ljquan/aitu/commit/614fc8b))

### 🔧 Chores

- bump version to 0.5.28 ([9fca109](https://github.com/ljquan/aitu/commit/9fca109))
- bump version to 0.5.27 ([0b3c40b](https://github.com/ljquan/aitu/commit/0b3c40b))
- bump version to 0.5.26 ([10b2b16](https://github.com/ljquan/aitu/commit/10b2b16))
- enhance CDN response validation and update version to 0.5.25 ([155ec00](https://github.com/ljquan/aitu/commit/155ec00))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.26 (2026-01-20)

### 🚀 Features

- add reference image handling in LLM API logs and enhance task recovery mechanisms ([c94b032](https://github.com/ljquan/aitu/commit/c94b032))
- implement model dropdown component with search functionality and update AI input bar to use # for model selection ([6aa6267](https://github.com/ljquan/aitu/commit/6aa6267))
- enhance performance panel with image count tracking and updated memory thresholds ([5ec5172](https://github.com/ljquan/aitu/commit/5ec5172))

### 🔧 Chores

- enhance CDN response validation and update version to 0.5.25 ([155ec00](https://github.com/ljquan/aitu/commit/155ec00))
- bump version to 0.5.25 ([8bd7f30](https://github.com/ljquan/aitu/commit/8bd7f30))
- bump version to 0.5.22 ([5571d3f](https://github.com/ljquan/aitu/commit/5571d3f))
- bump version to 0.5.21 ([55ad29c](https://github.com/ljquan/aitu/commit/55ad29c))
- bump version to 0.5.20 ([8bfc191](https://github.com/ljquan/aitu/commit/8bfc191))
- bump version to 0.5.19 ([8707a5b](https://github.com/ljquan/aitu/commit/8707a5b))
- bump version to 0.5.18 ([88c0dfd](https://github.com/ljquan/aitu/commit/88c0dfd))
- bump version to 0.5.17 ([91799c9](https://github.com/ljquan/aitu/commit/91799c9))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.23 (2026-01-20)

### 🚀 Features

- 优化素材库 UI 交互、缩放缓存、Grid 布局及空间效率 ([c64e4a7](https://github.com/ljquan/aitu/commit/c64e4a7))

### 🔧 Chores

- bump version to 0.5.22 ([5571d3f](https://github.com/ljquan/aitu/commit/5571d3f))
- bump version to 0.5.21 ([55ad29c](https://github.com/ljquan/aitu/commit/55ad29c))
- bump version to 0.5.20 ([8bfc191](https://github.com/ljquan/aitu/commit/8bfc191))
- bump version to 0.5.19 ([8707a5b](https://github.com/ljquan/aitu/commit/8707a5b))
- bump version to 0.5.18 ([88c0dfd](https://github.com/ljquan/aitu/commit/88c0dfd))
- bump version to 0.5.17 ([91799c9](https://github.com/ljquan/aitu/commit/91799c9))
- bump version to 0.5.17 and update build time in version.json ([51b5f3f](https://github.com/ljquan/aitu/commit/51b5f3f))
- bump version to 0.5.17 ([c41c9bd](https://github.com/ljquan/aitu/commit/c41c9bd))
- docs(claude): 更新调试日志处理和命令行工具使用说明，添加后台清理任务日志记录示例 ([30cf458](https://github.com/ljquan/aitu/commit/30cf458))
- docs(claude): 添加 React 事件委托、筛选逻辑、Grid 布局及 UI 高度统一规则 ([dcabd75](https://github.com/ljquan/aitu/commit/dcabd75))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.17 (2026-01-20)

### 🚀 Features

- 优化素材库 UI 交互、缩放缓存、Grid 布局及空间效率 ([c64e4a7](https://github.com/ljquan/aitu/commit/c64e4a7))
- implement CORS domain handling and cache validation ([de13297](https://github.com/ljquan/aitu/commit/de13297))
- 封装函数不应被绕过、页面卸载清理定时器 ([f6bd3af](https://github.com/ljquan/aitu/commit/f6bd3af))
- enhance prompt history management with preset prompts ([8e8738c](https://github.com/ljquan/aitu/commit/8e8738c))

### 🔧 Chores

- update paths for CDN compatibility and add npm publish scripts ([e4cdca4](https://github.com/ljquan/aitu/commit/e4cdca4))
- bump version to 0.5.16 ([ef30e2e](https://github.com/ljquan/aitu/commit/ef30e2e))
- bump version to 0.5.15 ([c126ed5](https://github.com/ljquan/aitu/commit/c126ed5))
- update project references from aitu.chat to Yue画布.ai ([345b0a9](https://github.com/ljquan/aitu/commit/345b0a9))
- bump version to 0.5.14 ([305fa7f](https://github.com/ljquan/aitu/commit/305fa7f))
- docs(claude): 添加 React 事件委托、筛选逻辑、Grid 布局及 UI 高度统一规则 ([dcabd75](https://github.com/ljquan/aitu/commit/dcabd75))
- docs(claude): 添加部署脚本安全实践规则 ([ad9ef4d](https://github.com/ljquan/aitu/commit/ad9ef4d))
- docs(claude): 添加新规则 - SSH 远程执行复杂 Shell 命令应使用 base64 编码 ([e37666f](https://github.com/ljquan/aitu/commit/e37666f))
- refactor(sw-debug): reorganize cache statistics panel and enhance LLM API log entry styles ([31f684f](https://github.com/ljquan/aitu/commit/31f684f))
- docs(claude): 添加 Service Worker opaque 响应处理和缓存验证规则 ([bdbaff4](https://github.com/ljquan/aitu/commit/bdbaff4))
- docs(claude): 添加缓存策略和数据一致性规则 ([310b7d0](https://github.com/ljquan/aitu/commit/310b7d0))
- docs(claude): 添加新规则 - 封装函数不应被绕过、页面卸载清理定时器 ([06ae079](https://github.com/ljquan/aitu/commit/06ae079))
- docs(claude): 添加独立页面配色一致性规则 ([7876471](https://github.com/ljquan/aitu/commit/7876471))
- docs(claude): 添加 UI 重构信息完整性和日志保留优先级规则 ([d402148](https://github.com/ljquan/aitu/commit/d402148))
- docs(claude): 添加组件空状态处理和文案通用性规则 ([d2c1569](https://github.com/ljquan/aitu/commit/d2c1569))
- v0.5.11 ([f7e6f0b](https://github.com/ljquan/aitu/commit/f7e6f0b))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.15 (2026-01-20)

### 🔧 Chores

- update project references from aitu.chat to Yue画布.ai ([345b0a9](https://github.com/ljquan/aitu/commit/345b0a9))
- bump version to 0.5.14 ([305fa7f](https://github.com/ljquan/aitu/commit/305fa7f))
- docs(claude): 添加部署脚本安全实践规则 ([ad9ef4d](https://github.com/ljquan/aitu/commit/ad9ef4d))
- docs(claude): 添加新规则 - SSH 远程执行复杂 Shell 命令应使用 base64 编码 ([e37666f](https://github.com/ljquan/aitu/commit/e37666f))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.14 (2026-01-19)

### 🚀 Features

- implement CORS domain handling and cache validation ([de13297](https://github.com/ljquan/aitu/commit/de13297))
- 封装函数不应被绕过、页面卸载清理定时器 ([f6bd3af](https://github.com/ljquan/aitu/commit/f6bd3af))
- enhance prompt history management with preset prompts ([8e8738c](https://github.com/ljquan/aitu/commit/8e8738c))
- implement user confirmation for service worker upgrades ([f0571a7](https://github.com/ljquan/aitu/commit/f0571a7))
- add memory monitoring and crash logging features ([19f54ec](https://github.com/ljquan/aitu/commit/19f54ec))

### 🩹 Fixes

- 修复 workflows Map 和 setInterval 内存泄漏 ([bfb7ed5](https://github.com/ljquan/aitu/commit/bfb7ed5))

### 🔧 Chores

- bump version to 0.5.13 ([2edadb3](https://github.com/ljquan/aitu/commit/2edadb3))
- bump version to 0.5.10 and update changelog ([305b5d7](https://github.com/ljquan/aitu/commit/305b5d7))
- refactor(sw-debug): reorganize cache statistics panel and enhance LLM API log entry styles ([31f684f](https://github.com/ljquan/aitu/commit/31f684f))
- docs(claude): 添加 Service Worker opaque 响应处理和缓存验证规则 ([bdbaff4](https://github.com/ljquan/aitu/commit/bdbaff4))
- docs(claude): 添加缓存策略和数据一致性规则 ([310b7d0](https://github.com/ljquan/aitu/commit/310b7d0))
- docs(claude): 添加新规则 - 封装函数不应被绕过、页面卸载清理定时器 ([06ae079](https://github.com/ljquan/aitu/commit/06ae079))
- docs(claude): 添加独立页面配色一致性规则 ([7876471](https://github.com/ljquan/aitu/commit/7876471))
- docs(claude): 添加 UI 重构信息完整性和日志保留优先级规则 ([d402148](https://github.com/ljquan/aitu/commit/d402148))
- docs(claude): 添加组件空状态处理和文案通用性规则 ([d2c1569](https://github.com/ljquan/aitu/commit/d2c1569))
- v0.5.11 ([f7e6f0b](https://github.com/ljquan/aitu/commit/f7e6f0b))
- 添加更多版本 ([c4c7e3d](https://github.com/ljquan/aitu/commit/c4c7e3d))
- docs(claude): 添加内存泄漏预防规则 ([d1112d0](https://github.com/ljquan/aitu/commit/d1112d0))
- docs(claude): 添加 SW 更新和配置同步规则 ([2fb1088](https://github.com/ljquan/aitu/commit/2fb1088))
- docs(claude): 添加新规则 - navigator.storage.estimate() 返回浏览器配额而非磁盘空间 ([c823877](https://github.com/ljquan/aitu/commit/c823877))
- 优化渐变 ([de86f2a](https://github.com/ljquan/aitu/commit/de86f2a))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.12 (2026-01-19)

### 🚀 Features

- implement CORS domain handling and cache validation ([de13297](https://github.com/ljquan/aitu/commit/de13297))
- 封装函数不应被绕过、页面卸载清理定时器 ([f6bd3af](https://github.com/ljquan/aitu/commit/f6bd3af))
- enhance prompt history management with preset prompts ([8e8738c](https://github.com/ljquan/aitu/commit/8e8738c))

### 🔧 Chores

- refactor(sw-debug): reorganize cache statistics panel and enhance LLM API log entry styles ([31f684f](https://github.com/ljquan/aitu/commit/31f684f))
- docs(claude): 添加 Service Worker opaque 响应处理和缓存验证规则 ([bdbaff4](https://github.com/ljquan/aitu/commit/bdbaff4))
- docs(claude): 添加缓存策略和数据一致性规则 ([310b7d0](https://github.com/ljquan/aitu/commit/310b7d0))
- docs(claude): 添加新规则 - 封装函数不应被绕过、页面卸载清理定时器 ([06ae079](https://github.com/ljquan/aitu/commit/06ae079))
- docs(claude): 添加独立页面配色一致性规则 ([7876471](https://github.com/ljquan/aitu/commit/7876471))
- docs(claude): 添加 UI 重构信息完整性和日志保留优先级规则 ([d402148](https://github.com/ljquan/aitu/commit/d402148))
- docs(claude): 添加组件空状态处理和文案通用性规则 ([d2c1569](https://github.com/ljquan/aitu/commit/d2c1569))
- v0.5.11 ([f7e6f0b](https://github.com/ljquan/aitu/commit/f7e6f0b))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.5.11 (2026-01-18)

### 🚀 Features

- implement user confirmation for service worker upgrades ([f0571a7](https://github.com/ljquan/aitu/commit/f0571a7))
- add memory monitoring and crash logging features ([19f54ec](https://github.com/ljquan/aitu/commit/19f54ec))

### 🩹 Fixes

- 修复 workflows Map 和 setInterval 内存泄漏 ([bfb7ed5](https://github.com/ljquan/aitu/commit/bfb7ed5))

### 🔧 Chores

- bump version to 0.5.10 and update changelog ([305b5d7](https://github.com/ljquan/aitu/commit/305b5d7))
- 添加更多版本 ([c4c7e3d](https://github.com/ljquan/aitu/commit/c4c7e3d))
- docs(claude): 添加内存泄漏预防规则 ([d1112d0](https://github.com/ljquan/aitu/commit/d1112d0))
- docs(claude): 添加 SW 更新和配置同步规则 ([2fb1088](https://github.com/ljquan/aitu/commit/2fb1088))
- docs(claude): 添加新规则 - navigator.storage.estimate() 返回浏览器配额而非磁盘空间 ([c823877](https://github.com/ljquan/aitu/commit/c823877))
- 优化渐变 ([de86f2a](https://github.com/ljquan/aitu/commit/de86f2a))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.10 (2026-01-17)

### 🔧 Chores

- v0.5.9 ([c1c5d5b](https://github.com/ljquan/aitu/commit/c1c5d5b))
- refactor(fill-panel): enhance fill panel functionality and styles ([160170b](https://github.com/ljquan/aitu/commit/160170b))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.9 (2026-01-17)

### 🚀 Features

- enhance fill options with gradient and image support ([206af04](https://github.com/ljquan/aitu/commit/206af04))

### 🔧 Chores

- bump version to 0.5.8 and update changelog ([8f5953b](https://github.com/ljquan/aitu/commit/8f5953b))
- update version to 0.5.2 and enhance fill panel styles ([e2b4a84](https://github.com/ljquan/aitu/commit/e2b4a84))
- feat： 调整4k配置 ([5bfcb9e](https://github.com/ljquan/aitu/commit/5bfcb9e))
- docs(claude): 添加异步任务幂等性检查规则 ([e046e57](https://github.com/ljquan/aitu/commit/e046e57))
- docs(claude): 添加单击/双击区分场景的计时器清理规则 ([079374c](https://github.com/ljquan/aitu/commit/079374c))
- docs(claude): 添加 Service Worker 更新提示开发模式规则 ([9b8f79e](https://github.com/ljquan/aitu/commit/9b8f79e))
- docs(claude): 更新规则 - 滑块节流和 Plait API 签名 ([2286e34](https://github.com/ljquan/aitu/commit/2286e34))
- docs(claude): 添加工具函数使用和滑块更新策略规则 ([f51f914](https://github.com/ljquan/aitu/commit/f51f914))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- liquidliang <ljquan@qq.com>

## 0.5.8 (2026-01-17)

### 🚀 Features

- add debug panel and logging enhancements ([12576ee](https://github.com/ljquan/aitu/commit/12576ee))

### 🔧 Chores

- bump version to 0.5.7 and update changelog ([b38a485](https://github.com/ljquan/aitu/commit/b38a485))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.7 (2026-01-17)

### 🚀 Features

- enhance postMessage logging and workflow recovery ([d76a0e9](https://github.com/ljquan/aitu/commit/d76a0e9))

### 🔧 Chores

- bump version to 0.5.6 and update changelog ([6855673](https://github.com/ljquan/aitu/commit/6855673))
- refactor(ai-input-bar, project-drawer): remove debug logs and add cleanup effect ([b1f58f5](https://github.com/ljquan/aitu/commit/b1f58f5))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.6 (2026-01-17)

### 🚀 Features

- add touch support for mobile interactions ([d7a30ea](https://github.com/ljquan/aitu/commit/d7a30ea))

### 🔧 Chores

- bump version to 0.5.5 and update changelog ([e4b7c79](https://github.com/ljquan/aitu/commit/e4b7c79))
- style(ai-input-bar, version-update-prompt): enhance responsiveness and positioning for mobile devices ([bbcd896](https://github.com/ljquan/aitu/commit/bbcd896))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.5 (2026-01-17)

### 🚀 Features

- 添加双击重命名功能 ([e7968f1](https://github.com/ljquan/aitu/commit/e7968f1))

### 🔧 Chores

- bump version to 0.5.4 and update changelog ([9baf1a7](https://github.com/ljquan/aitu/commit/9baf1a7))
- refactor(storage): enhance database version handling and integrity checks ([dcfd46a](https://github.com/ljquan/aitu/commit/dcfd46a))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- Claude Code <claude@anthropic.com>

## 0.5.4 (2026-01-17)

### 🩹 Fixes

- improve version update handling and error response caching ([eb8da7e](https://github.com/ljquan/aitu/commit/eb8da7e))

### 🔧 Chores

- bump version to 0.5.3 and update changelog ([d83ffc4](https://github.com/ljquan/aitu/commit/d83ffc4))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.5.3 (2026-01-16)

### 🔧 Chores

- 去掉重试逻辑 ([77391d8](https://github.com/ljquan/aitu/commit/77391d8))
- v0.5.2 ([470742f](https://github.com/ljquan/aitu/commit/470742f))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.5.2 (2026-01-16)

### 🚀 Features

- add multi-selection resize functionality and new stroke styles ([85271a2](https://github.com/ljquan/aitu/commit/85271a2))
- implement viewport saving and restoration functionality ([e8b1f31](https://github.com/ljquan/aitu/commit/e8b1f31))
- add corner radius feature and enhance pen settings ([05b9a4d](https://github.com/ljquan/aitu/commit/05b9a4d))
- 当 API 返回 401 错误时自动打开设置对话框 ([ec60835](https://github.com/ljquan/aitu/commit/ec60835))
- 优化工具栏交互体验 ([3077f76](https://github.com/ljquan/aitu/commit/3077f76))
- 支持保存文件时嵌入媒体数据 ([cb2fcac](https://github.com/ljquan/aitu/commit/cb2fcac))
- 使用统一拾色器替换阴影和渐变的颜色选择器 ([5c2b5d8](https://github.com/ljquan/aitu/commit/5c2b5d8))
- 添加画笔描边样式设置并将画笔工具移至工具栏 ([9651a75](https://github.com/ljquan/aitu/commit/9651a75))
- 优化画笔和橡皮擦功能 ([79e1edf](https://github.com/ljquan/aitu/commit/79e1edf))
- 实现画笔和橡皮擦设置工具栏 ([1d5ceea](https://github.com/ljquan/aitu/commit/1d5ceea))
- 素材库增加 unified-cache 数据源 ([e0d23fa](https://github.com/ljquan/aitu/commit/e0d23fa))
- 添加备份恢复功能支持导出导入提示词、项目和素材 ([ee8f66f](https://github.com/ljquan/aitu/commit/ee8f66f))
- 添加参考图片智能处理和压缩功能 ([250cd1b](https://github.com/ljquan/aitu/commit/250cd1b))
- 集成 Sentry 错误监控并修复角色 API ([dc4c81e](https://github.com/ljquan/aitu/commit/dc4c81e))
- 优化图层控制面板和任务队列交互 ([2d4bb28](https://github.com/ljquan/aitu/commit/2d4bb28))
- 添加任务多选和批量操作功能 ([85ead4c](https://github.com/ljquan/aitu/commit/85ead4c))
- 增强批量出图功能和任务超时机制 ([2f26597](https://github.com/ljquan/aitu/commit/2f26597))
- 实现视频提示词即时保存到预设列表 ([275a7ff](https://github.com/ljquan/aitu/commit/275a7ff))
- 添加 isDataReady 状态防止灵感板闪烁 ([c615c27](https://github.com/ljquan/aitu/commit/c615c27))
- 添加 Claude Code 工作流自动化斜杠命令 ([3353665](https://github.com/ljquan/aitu/commit/3353665))
- 添加提示词预设置顶和删除功能 ([06e7ba9](https://github.com/ljquan/aitu/commit/06e7ba9))
- 完善 Service Worker 任务队列和工作流执行 ([b99f452](https://github.com/ljquan/aitu/commit/b99f452))
- 添加阴影颜色设置并加宽面板 ([765ed7d](https://github.com/ljquan/aitu/commit/765ed7d))
- 完善文本属性面板和字体管理系统 ([057fdef](https://github.com/ljquan/aitu/commit/057fdef))
- 添加智能文本粘贴功能和文档更新命令 ([334dfd0](https://github.com/ljquan/aitu/commit/334dfd0))
- 增强图片合并功能，支持图形、线条、手绘等元素 ([2c769d5](https://github.com/ljquan/aitu/commit/2c769d5))
- 增强视频缓存持久化和素材库 URL 支持 ([8d45cb8](https://github.com/ljquan/aitu/commit/8d45cb8))
- 增强图片尺寸感知和智能缓存处理 ([740f953](https://github.com/ljquan/aitu/commit/740f953))
- 实现合并视频的 Service Worker 缓存方案 ([e058f92](https://github.com/ljquan/aitu/commit/e058f92))
- 添加提示词工具快捷入口 ([c2ff40a](https://github.com/ljquan/aitu/commit/c2ff40a))
- 添加历史提示词功能支持置顶 ([bb52bc6](https://github.com/ljquan/aitu/commit/bb52bc6))
- 实现统一图片缓存系统 ([e8bd3ca](https://github.com/ljquan/aitu/commit/e8bd3ca))
- 添加 SizeDropdown 组件优化生图模型尺寸参数适配 ([8b49477](https://github.com/ljquan/aitu/commit/8b49477))
- 实现工作区缩放和左对齐插入位置功能 ([0b4516c](https://github.com/ljquan/aitu/commit/0b4516c))
- 新增共享工具函数库并重构相关代码 ([a34e2eb](https://github.com/ljquan/aitu/commit/a34e2eb))
- 添加灵感板组件和内容上传功能 ([531e612](https://github.com/ljquan/aitu/commit/531e612))

### 🩹 Fixes

- 修复备份恢复服务的 TypeScript 类型错误 ([8181a3f](https://github.com/ljquan/aitu/commit/8181a3f))
- improve key assignment and stroke width calculation ([52bf30f](https://github.com/ljquan/aitu/commit/52bf30f))
- use pnpm instead of npm for Vercel deployment ([315fd5d](https://github.com/ljquan/aitu/commit/315fd5d))
- 移除自动删除用户数据的逻辑 ([0942aa5](https://github.com/ljquan/aitu/commit/0942aa5))
- 修复 agent_flow 工作流卡在"待开始"状态的问题 ([718c644](https://github.com/ljquan/aitu/commit/718c644))
- 修复页面加载时小地图自动展开的问题 ([9cd009d](https://github.com/ljquan/aitu/commit/9cd009d))
- 修复宫格图生成时未使用选择的图像模型 ([2d88b98](https://github.com/ljquan/aitu/commit/2d88b98))
- 优化尺寸参数优先级策略 ([650b9c5](https://github.com/ljquan/aitu/commit/650b9c5))
- 修复任务删除和视频并发生成问题 ([906e0d6](https://github.com/ljquan/aitu/commit/906e0d6))
- 修复 API Key 加密问题和参考图残留问题 ([d11752e](https://github.com/ljquan/aitu/commit/d11752e))
- 修复 z-index 层级和双击事件穿透问题 ([cea2642](https://github.com/ljquan/aitu/commit/cea2642))
- 修复工作流重复提交和发送按钮状态问题 ([6ce9690](https://github.com/ljquan/aitu/commit/6ce9690))
- 修复多行 console.log 注释导致的语法错误 ([124b5dd](https://github.com/ljquan/aitu/commit/124b5dd))
- 修复画板初始状态闪烁问题并优化视频恢复逻辑 ([0a1aa0c](https://github.com/ljquan/aitu/commit/0a1aa0c))
- 改进LLM响应解析的健壮性 ([dd7c0d9](https://github.com/ljquan/aitu/commit/dd7c0d9))
- 修正示例1中图片生成提示词过于扩展的问题 ([6d2ffd6](https://github.com/ljquan/aitu/commit/6d2ffd6))
- 移除手动分包让Vite自动处理避免循环依赖 ([d9cfe7d](https://github.com/ljquan/aitu/commit/d9cfe7d))
- 更新CSP策略添加us-assets.i.posthog.com域名 feat(sw): 添加对非http/https请求的过滤 docs: 更新文档添加service worker源码路径 chore: 更新构建时间和版本信息 ([6b011de](https://github.com/ljquan/aitu/commit/6b011de))
- 仅缓存HTTP请求的响应以避免错误 ([f6c022a](https://github.com/ljquan/aitu/commit/f6c022a))

### 🔧 Chores

- 清理 console.log 调试日志 ([77340d8](https://github.com/ljquan/aitu/commit/77340d8))
- 发布版本 0.5.0 ([d2befb1](https://github.com/ljquan/aitu/commit/d2befb1))
- 注释掉所有 console.log/debug/info 日志 ([9fe03cf](https://github.com/ljquan/aitu/commit/9fe03cf))
- 更新版本号至0.4.3并优化vite分包配置 ([3349854](https://github.com/ljquan/aitu/commit/3349854))
- 更新构建命令和版本文件时间戳 ([9ec3837](https://github.com/ljquan/aitu/commit/9ec3837))
- docs(claude): 添加新规则 - 生产代码禁止保留调试日志 ([00df2f7](https://github.com/ljquan/aitu/commit/00df2f7))
- refactor(task-queue): 移除重复提交检测并优化存储性能 ([e1785a8](https://github.com/ljquan/aitu/commit/e1785a8))
- docs(claude): 添加新规则 - 重复提交检测应由 UI 层处理 ([c2e367f](https://github.com/ljquan/aitu/commit/c2e367f))
- docs(claude): 添加新规则 - API 请求禁止重试 ([b564930](https://github.com/ljquan/aitu/commit/b564930))
- refactor(api): 移除 API 重试逻辑简化错误处理 ([4ba9774](https://github.com/ljquan/aitu/commit/4ba9774))
- 优化画笔 ([2a66799](https://github.com/ljquan/aitu/commit/2a66799))
- docs(claude): 添加新规则 - 扩展外部库的枚举类型 ([156668e](https://github.com/ljquan/aitu/commit/156668e))
- docs(claude): 添加新规则 - Plait 选中状态渲染触发 ([34db489](https://github.com/ljquan/aitu/commit/34db489))
- docs(claude): 添加新规则 - Hover 延迟操作计时器清理 ([ebe979f](https://github.com/ljquan/aitu/commit/ebe979f))
- docs(claude): 添加新规则 - 元组类型 vs 数组类型 ([82f9d7a](https://github.com/ljquan/aitu/commit/82f9d7a))
- 优化形状 ([ceff394](https://github.com/ljquan/aitu/commit/ceff394))
- docs(claude): 添加新规则 - 对象字面量只能指定已知属性 ([378a512](https://github.com/ljquan/aitu/commit/378a512))
- docs(claude): 添加新规则 - 高频事件处理性能优化 ([1cfe7b4](https://github.com/ljquan/aitu/commit/1cfe7b4))
- docs(claude): 添加新规则 - PointerEvent 压力感应兼容性 ([70f325e](https://github.com/ljquan/aitu/commit/70f325e))
- 优化滑块位置 ([fec0f9b](https://github.com/ljquan/aitu/commit/fec0f9b))
- docs(claude): 添加新规则 - 绝对定位子元素需要正确的父容器设置 ([babc0f9](https://github.com/ljquan/aitu/commit/babc0f9))
- docs(claude): 添加新规则 - 新增 UI 组件需同步更新全局事件排除列表 ([4876bc8](https://github.com/ljquan/aitu/commit/4876bc8))
- docs(claude): 添加新规则 - 相对路径 URL 解析规范 ([1c988de](https://github.com/ljquan/aitu/commit/1c988de))
- 优化缓存获取 ([dbafcc4](https://github.com/ljquan/aitu/commit/dbafcc4))
- docs(claude): 添加新规则 - Cache API 缓存 key 一致性规范 ([bb22cae](https://github.com/ljquan/aitu/commit/bb22cae))
- 添加调试日志 ([4a5675b](https://github.com/ljquan/aitu/commit/4a5675b))
- docs(claude): 添加新规则 - Service Worker 内部处理虚拟路径 URL ([fceb939](https://github.com/ljquan/aitu/commit/fceb939))
- docs(claude): 添加新规则 - 虚拟路径 URL 匹配规范 ([91c1f65](https://github.com/ljquan/aitu/commit/91c1f65))
- docs(claude): 添加新规则 - 媒体 URL 处理规范（避免 CSP 和生命周期问题） ([f8272b4](https://github.com/ljquan/aitu/commit/f8272b4))
- style(text-property): 自定义渐变和预设渐变放在同一行展示 ([004cd48](https://github.com/ljquan/aitu/commit/004cd48))
- style(text-property): 调整阴影渐变拾色器宽度与设置面板一致 ([588b2ea](https://github.com/ljquan/aitu/commit/588b2ea))
- docs(claude): 添加新规则 - Freehand 元素属性设置需要自定义 callback ([e27bf28](https://github.com/ljquan/aitu/commit/e27bf28))
- docs(claude): 添加调试日志清理规范 ([3ad8400](https://github.com/ljquan/aitu/commit/3ad8400))
- refactor(image): extract shared border trimming utilities and update development guidelines ([90fad36](https://github.com/ljquan/aitu/commit/90fad36))
- docs: 添加 Service Worker 初始化时序规则 ([3dfa4d1](https://github.com/ljquan/aitu/commit/3dfa4d1))
- 去掉删除遗留db问题 ([c86ebba](https://github.com/ljquan/aitu/commit/c86ebba))
- 注释掉调试日志 ([898b77b](https://github.com/ljquan/aitu/commit/898b77b))
- perf(media-library): 实现任务队列和素材库的分页加载与虚拟滚动 ([5ace768](https://github.com/ljquan/aitu/commit/5ace768))
- docs(readme): 添加 Vercel 和 Netlify 一键部署按钮 ([424b1b8](https://github.com/ljquan/aitu/commit/424b1b8))
- deps: 移除 @sentry/react 并升级 typescript ([155d05e](https://github.com/ljquan/aitu/commit/155d05e))
- 优化导出 ([7b9d2eb](https://github.com/ljquan/aitu/commit/7b9d2eb))
- perf(image): 优化图片压缩算法使用二分查找 ([596a689](https://github.com/ljquan/aitu/commit/596a689))
- 迁移存储 ([0608b09](https://github.com/ljquan/aitu/commit/0608b09))
- docs(codebuddy): 添加 Sora-2 角色 API 约定文档 ([f25a09d](https://github.com/ljquan/aitu/commit/f25a09d))
- 完善命令 ([866c87a](https://github.com/ljquan/aitu/commit/866c87a))
- 优化提示词 ([a54ce64](https://github.com/ljquan/aitu/commit/a54ce64))
- 更新Claude.md ([bf34c5c](https://github.com/ljquan/aitu/commit/bf34c5c))
- 优化 ([574e17e](https://github.com/ljquan/aitu/commit/574e17e))
- 优化插入位置 ([70ee8f9](https://github.com/ljquan/aitu/commit/70ee8f9))
-  优化 ([0ab27b1](https://github.com/ljquan/aitu/commit/0ab27b1))
- 优化素材库展示 ([0a876a0](https://github.com/ljquan/aitu/commit/0a876a0))
- 优化图片上传到素材库 ([ff7a07d](https://github.com/ljquan/aitu/commit/ff7a07d))
- 优化缓存 ([7b65b7c](https://github.com/ljquan/aitu/commit/7b65b7c))
- style(ai-input-bar): 优化灵感板与输入框的无缝连接UI ([767f8c8](https://github.com/ljquan/aitu/commit/767f8c8))
- docs: 更新 CLAUDE.md 文档，添加新功能说明 ([fcfe109](https://github.com/ljquan/aitu/commit/fcfe109))
- docs(agent): 更新系统提示以明确JSON响应格式要求 ([b01ddf5](https://github.com/ljquan/aitu/commit/b01ddf5))
- refactor(vite配置): 简化分包策略让Vite自动处理依赖 ([05c1b37](https://github.com/ljquan/aitu/commit/05c1b37))
- refactor(vite配置): 移除mermaid手动分包改为自动处理 ([0b0cd48](https://github.com/ljquan/aitu/commit/0b0cd48))
- refactor(vite): 简化mermaid打包配置以避免循环依赖问题 ([f5c1ff5](https://github.com/ljquan/aitu/commit/f5c1ff5))
- build: 更新构建配置和依赖项 ([216f157](https://github.com/ljquan/aitu/commit/216f157))
- refactor(utils): 重构工具模块并迁移共享代码到独立包 ([69233dd](https://github.com/ljquan/aitu/commit/69233dd))
- perf(vite): 优化手动分块策略以按需加载依赖 ([5055de6](https://github.com/ljquan/aitu/commit/5055de6))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.5.0 (2026-01-13)

### 🚀 Features

- 添加备份恢复功能支持导出导入提示词、项目和素材 ([ee8f66f](https://github.com/ljquan/aitu/commit/ee8f66f))
- 添加参考图片智能处理和压缩功能 ([250cd1b](https://github.com/ljquan/aitu/commit/250cd1b))
- 集成 Sentry 错误监控并修复角色 API ([dc4c81e](https://github.com/ljquan/aitu/commit/dc4c81e))
- 优化图层控制面板和任务队列交互 ([2d4bb28](https://github.com/ljquan/aitu/commit/2d4bb28))
- 添加任务多选和批量操作功能 ([85ead4c](https://github.com/ljquan/aitu/commit/85ead4c))
- 增强批量出图功能和任务超时机制 ([2f26597](https://github.com/ljquan/aitu/commit/2f26597))
- 实现视频提示词即时保存到预设列表 ([275a7ff](https://github.com/ljquan/aitu/commit/275a7ff))
- 添加 isDataReady 状态防止灵感板闪烁 ([c615c27](https://github.com/ljquan/aitu/commit/c615c27))
- 添加 Claude Code 工作流自动化斜杠命令 ([3353665](https://github.com/ljquan/aitu/commit/3353665))
- 添加提示词预设置顶和删除功能 ([06e7ba9](https://github.com/ljquan/aitu/commit/06e7ba9))
- 完善 Service Worker 任务队列和工作流执行 ([b99f452](https://github.com/ljquan/aitu/commit/b99f452))
- 添加阴影颜色设置并加宽面板 ([765ed7d](https://github.com/ljquan/aitu/commit/765ed7d))
- 完善文本属性面板和字体管理系统 ([057fdef](https://github.com/ljquan/aitu/commit/057fdef))
- 添加智能文本粘贴功能和文档更新命令 ([334dfd0](https://github.com/ljquan/aitu/commit/334dfd0))
- 增强图片合并功能，支持图形、线条、手绘等元素 ([2c769d5](https://github.com/ljquan/aitu/commit/2c769d5))
- 增强视频缓存持久化和素材库 URL 支持 ([8d45cb8](https://github.com/ljquan/aitu/commit/8d45cb8))
- 增强图片尺寸感知和智能缓存处理 ([740f953](https://github.com/ljquan/aitu/commit/740f953))
- 实现合并视频的 Service Worker 缓存方案 ([e058f92](https://github.com/ljquan/aitu/commit/e058f92))
- 添加提示词工具快捷入口 ([c2ff40a](https://github.com/ljquan/aitu/commit/c2ff40a))
- 添加历史提示词功能支持置顶 ([bb52bc6](https://github.com/ljquan/aitu/commit/bb52bc6))
- 实现统一图片缓存系统 ([e8bd3ca](https://github.com/ljquan/aitu/commit/e8bd3ca))
- 添加 SizeDropdown 组件优化生图模型尺寸参数适配 ([8b49477](https://github.com/ljquan/aitu/commit/8b49477))
- 实现工作区缩放和左对齐插入位置功能 ([0b4516c](https://github.com/ljquan/aitu/commit/0b4516c))
- 新增共享工具函数库并重构相关代码 ([a34e2eb](https://github.com/ljquan/aitu/commit/a34e2eb))
- 添加灵感板组件和内容上传功能 ([531e612](https://github.com/ljquan/aitu/commit/531e612))

### 🩹 Fixes

- 优化尺寸参数优先级策略 ([650b9c5](https://github.com/ljquan/aitu/commit/650b9c5))
- 修复任务删除和视频并发生成问题 ([906e0d6](https://github.com/ljquan/aitu/commit/906e0d6))
- 修复 API Key 加密问题和参考图残留问题 ([d11752e](https://github.com/ljquan/aitu/commit/d11752e))
- 修复 z-index 层级和双击事件穿透问题 ([cea2642](https://github.com/ljquan/aitu/commit/cea2642))
- 修复工作流重复提交和发送按钮状态问题 ([6ce9690](https://github.com/ljquan/aitu/commit/6ce9690))
- 修复多行 console.log 注释导致的语法错误 ([124b5dd](https://github.com/ljquan/aitu/commit/124b5dd))
- 修复画板初始状态闪烁问题并优化视频恢复逻辑 ([0a1aa0c](https://github.com/ljquan/aitu/commit/0a1aa0c))
- 改进LLM响应解析的健壮性 ([dd7c0d9](https://github.com/ljquan/aitu/commit/dd7c0d9))
- 修正示例1中图片生成提示词过于扩展的问题 ([6d2ffd6](https://github.com/ljquan/aitu/commit/6d2ffd6))
- 移除手动分包让Vite自动处理避免循环依赖 ([d9cfe7d](https://github.com/ljquan/aitu/commit/d9cfe7d))
- 更新CSP策略添加us-assets.i.posthog.com域名 feat(sw): 添加对非http/https请求的过滤 docs: 更新文档添加service worker源码路径 chore: 更新构建时间和版本信息 ([6b011de](https://github.com/ljquan/aitu/commit/6b011de))
- 仅缓存HTTP请求的响应以避免错误 ([f6c022a](https://github.com/ljquan/aitu/commit/f6c022a))

### 🔧 Chores

- 注释掉所有 console.log/debug/info 日志 ([9fe03cf](https://github.com/ljquan/aitu/commit/9fe03cf))
- 更新版本号至0.4.3并优化vite分包配置 ([3349854](https://github.com/ljquan/aitu/commit/3349854))
- 更新构建命令和版本文件时间戳 ([9ec3837](https://github.com/ljquan/aitu/commit/9ec3837))
- deps: 移除 @sentry/react 并升级 typescript ([155d05e](https://github.com/ljquan/aitu/commit/155d05e))
- 优化导出 ([7b9d2eb](https://github.com/ljquan/aitu/commit/7b9d2eb))
- perf(image): 优化图片压缩算法使用二分查找 ([596a689](https://github.com/ljquan/aitu/commit/596a689))
- 迁移存储 ([0608b09](https://github.com/ljquan/aitu/commit/0608b09))
- docs(codebuddy): 添加 Sora-2 角色 API 约定文档 ([f25a09d](https://github.com/ljquan/aitu/commit/f25a09d))
- 完善命令 ([866c87a](https://github.com/ljquan/aitu/commit/866c87a))
- 优化提示词 ([a54ce64](https://github.com/ljquan/aitu/commit/a54ce64))
- 更新Claude.md ([bf34c5c](https://github.com/ljquan/aitu/commit/bf34c5c))
- 优化 ([574e17e](https://github.com/ljquan/aitu/commit/574e17e))
- 优化插入位置 ([70ee8f9](https://github.com/ljquan/aitu/commit/70ee8f9))
-  优化 ([0ab27b1](https://github.com/ljquan/aitu/commit/0ab27b1))
- 优化素材库展示 ([0a876a0](https://github.com/ljquan/aitu/commit/0a876a0))
- 优化图片上传到素材库 ([ff7a07d](https://github.com/ljquan/aitu/commit/ff7a07d))
- 优化缓存 ([7b65b7c](https://github.com/ljquan/aitu/commit/7b65b7c))
- style(ai-input-bar): 优化灵感板与输入框的无缝连接UI ([767f8c8](https://github.com/ljquan/aitu/commit/767f8c8))
- docs: 更新 CLAUDE.md 文档，添加新功能说明 ([fcfe109](https://github.com/ljquan/aitu/commit/fcfe109))
- docs(agent): 更新系统提示以明确JSON响应格式要求 ([b01ddf5](https://github.com/ljquan/aitu/commit/b01ddf5))
- refactor(vite配置): 简化分包策略让Vite自动处理依赖 ([05c1b37](https://github.com/ljquan/aitu/commit/05c1b37))
- refactor(vite配置): 移除mermaid手动分包改为自动处理 ([0b0cd48](https://github.com/ljquan/aitu/commit/0b0cd48))
- refactor(vite): 简化mermaid打包配置以避免循环依赖问题 ([f5c1ff5](https://github.com/ljquan/aitu/commit/f5c1ff5))
- build: 更新构建配置和依赖项 ([216f157](https://github.com/ljquan/aitu/commit/216f157))
- refactor(utils): 重构工具模块并迁移共享代码到独立包 ([69233dd](https://github.com/ljquan/aitu/commit/69233dd))
- perf(vite): 优化手动分块策略以按需加载依赖 ([5055de6](https://github.com/ljquan/aitu/commit/5055de6))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.4.2 (2026-01-07)

### 🩹 Fixes

- 移除手动分包让Vite自动处理避免循环依赖 ([edbc280](https://github.com/ljquan/aitu/commit/edbc280))

### 🔧 Chores

- refactor(vite配置): 移除mermaid手动分包改为自动处理 ([3d47e65](https://github.com/ljquan/aitu/commit/3d47e65))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.4.1 (2026-01-07)

### 🚀 Features

- 新增共享工具函数库并重构相关代码 ([9b3c35b](https://github.com/ljquan/aitu/commit/9b3c35b))
- 添加Service Worker构建配置并更新开发模式处理 ([71fdd65](https://github.com/ljquan/aitu/commit/71fdd65))
- 为AI输入栏、聊天抽屉和弹出工具栏添加事件追踪 ([24e5162](https://github.com/ljquan/aitu/commit/24e5162))
- 更新版本至0.4.0，添加快捷工具栏并优化工具栏配置 ([8627823](https://github.com/ljquan/aitu/commit/8627823))
- 升级版本至0.4.0并添加更新日志功能 ([222ff9e](https://github.com/ljquan/aitu/commit/222ff9e))
- 添加版本更新提示组件和交互逻辑 ([9084f9a](https://github.com/ljquan/aitu/commit/9084f9a))
- 更新版本信息和初始化数据加载方式 ([e0fed52](https://github.com/ljquan/aitu/commit/e0fed52))
- 优化 WorkZone 位置策略 ([604ef48](https://github.com/ljquan/aitu/commit/604ef48))
- 添加长视频生成与恢复功能 ([c7c3fa2](https://github.com/ljquan/aitu/commit/c7c3fa2))
- 发送工作流时不自动展开 ChatDrawer ([3275cd1](https://github.com/ljquan/aitu/commit/3275cd1))
- 添加 WorkZone 画布元素显示工作流进度 ([74ef571](https://github.com/ljquan/aitu/commit/74ef571))
- 添加 @ 触发模型选择和固定底栏布局 ([d409912](https://github.com/ljquan/aitu/commit/d409912))
- 添加长视频生成功能 ([2f5d84f](https://github.com/ljquan/aitu/commit/2f5d84f))
- 添加共享选中内容预览组件并重构相关代码 ([2a8be45](https://github.com/ljquan/aitu/commit/2a8be45))
- 增强文本选择和复制功能并优化布局 ([655e5a3](https://github.com/ljquan/aitu/commit/655e5a3))
- 添加SVG工具支持矢量图插入画布 ([404e8e1](https://github.com/ljquan/aitu/commit/404e8e1))
- 添加AI分析内容显示和工作流消息优化 ([8cd8277](https://github.com/ljquan/aitu/commit/8cd8277))
- 添加插入元素后自动滚动到视口的功能 ([1671c60](https://github.com/ljquan/aitu/commit/1671c60))

### 🩹 Fixes

- 更新CSP策略添加us-assets.i.posthog.com域名 feat(sw): 添加对非http/https请求的过滤 docs: 更新文档添加service worker源码路径 chore: 更新构建时间和版本信息 ([618eb11](https://github.com/ljquan/aitu/commit/618eb11))
- 仅缓存HTTP请求的响应以避免错误 ([405b9b1](https://github.com/ljquan/aitu/commit/405b9b1))
- WorkZone 元素不触发 popup-toolbar ([bc6298b](https://github.com/ljquan/aitu/commit/bc6298b))
- 优化白边检测逻辑并改进图片分割策略 ([c864077](https://github.com/ljquan/aitu/commit/c864077))
- 修复工具栏按钮在打开状态时仍显示标题的问题 ([8973b8b](https://github.com/ljquan/aitu/commit/8973b8b))
- 优化宫格图分割逻辑，避免误裁透明背景角色 ([795fd28](https://github.com/ljquan/aitu/commit/795fd28))
- 修复消息提示实例未正确关闭的问题 ([0a5fbb9](https://github.com/ljquan/aitu/commit/0a5fbb9))
- 优化图片生成错误信息，返回原始 API 错误内容 ([0c38f4c](https://github.com/ljquan/aitu/commit/0c38f4c))

### 🔧 Chores

- 更新构建命令和版本文件时间戳 ([8827450](https://github.com/ljquan/aitu/commit/8827450))
- 将package-lock.json添加到.gitignore中 ([c9730ac](https://github.com/ljquan/aitu/commit/c9730ac))
- refactor(vite): 简化mermaid打包配置以避免循环依赖问题 ([a216206](https://github.com/ljquan/aitu/commit/a216206))
- build: 更新构建配置和依赖项 ([fef8673](https://github.com/ljquan/aitu/commit/fef8673))
- refactor(utils): 重构工具模块并迁移共享代码到独立包 ([b88e027](https://github.com/ljquan/aitu/commit/b88e027))
- perf(vite): 优化手动分块策略以按需加载依赖 ([bd87da4](https://github.com/ljquan/aitu/commit/bd87da4))
- refactor: 移除不必要的 rollupOptions 配置 ([936e9a9](https://github.com/ljquan/aitu/commit/936e9a9))
- refactor: 移除未使用的ffmpeg依赖和视频合并服务 ([51ecdb2](https://github.com/ljquan/aitu/commit/51ecdb2))
- docs: 更新 CLAUDE.md 添加 WorkZone 文档 ([3f9d194](https://github.com/ljquan/aitu/commit/3f9d194))
- 优化 ([d785603](https://github.com/ljquan/aitu/commit/d785603))
- 优化宫格拆图 ([47e4ca7](https://github.com/ljquan/aitu/commit/47e4ca7))
- 优化宫格图 ([acf2372](https://github.com/ljquan/aitu/commit/acf2372))
- 优化历史提示词展示 ([cf0f174](https://github.com/ljquan/aitu/commit/cf0f174))
- 优化提示词 ([cdd5ac4](https://github.com/ljquan/aitu/commit/cdd5ac4))
- 优化拆分 ([7c4d4fe](https://github.com/ljquan/aitu/commit/7c4d4fe))
- 优化拆图 ([39885a1](https://github.com/ljquan/aitu/commit/39885a1))
- 优化拆图 ([e072ca0](https://github.com/ljquan/aitu/commit/e072ca0))
- 照片墙改成灵感图 ([e3f1d9a](https://github.com/ljquan/aitu/commit/e3f1d9a))
- 优化拆分 ([0d1ebce](https://github.com/ljquan/aitu/commit/0d1ebce))
- 优化模型注入 ([97d113e](https://github.com/ljquan/aitu/commit/97d113e))
- 优化对话抽屉 ([d7b1714](https://github.com/ljquan/aitu/commit/d7b1714))
- 优化抽屉输入框 ([cfb87f3](https://github.com/ljquan/aitu/commit/cfb87f3))
- 对话抽屉换到右侧 ([50c8e72](https://github.com/ljquan/aitu/commit/50c8e72))
- 优化去白边 ([94d2e24](https://github.com/ljquan/aitu/commit/94d2e24))
- 优化 ([a49eba8](https://github.com/ljquan/aitu/commit/a49eba8))
- 优化拆分 ([49828b8](https://github.com/ljquan/aitu/commit/49828b8))
- 优化拆图 ([22afb18](https://github.com/ljquan/aitu/commit/22afb18))
- 添加照片墙 ([24f1bee](https://github.com/ljquan/aitu/commit/24f1bee))
- 修改概念 ([5213d28](https://github.com/ljquan/aitu/commit/5213d28))
- 下载 ([9f924a1](https://github.com/ljquan/aitu/commit/9f924a1))
- 优化切图 ([f299821](https://github.com/ljquan/aitu/commit/f299821))
- 优化 ([99d3342](https://github.com/ljquan/aitu/commit/99d3342))
- 生成照片墙 ([b17cf46](https://github.com/ljquan/aitu/commit/b17cf46))
- 优化图、视频mcp ([8f2cee5](https://github.com/ljquan/aitu/commit/8f2cee5))
- 添加思维导图mcp ([ab51889](https://github.com/ljquan/aitu/commit/ab51889))
- 增加冷启动提示词 ([c705055](https://github.com/ljquan/aitu/commit/c705055))
- 修复对话 ([a11d401](https://github.com/ljquan/aitu/commit/a11d401))
- 优化指令 ([9f8ad01](https://github.com/ljquan/aitu/commit/9f8ad01))
- 优化工作流实现 ([ba00566](https://github.com/ljquan/aitu/commit/ba00566))
- 优化点击 ([904a6c5](https://github.com/ljquan/aitu/commit/904a6c5))
- 优化 ([f096ce2](https://github.com/ljquan/aitu/commit/f096ce2))
- 优化提示词 ([f281595](https://github.com/ljquan/aitu/commit/f281595))
- 优化数量选择 ([18ca11d](https://github.com/ljquan/aitu/commit/18ca11d))
- 优化多任务 ([61c615b](https://github.com/ljquan/aitu/commit/61c615b))
- 优化删除 ([f000e29](https://github.com/ljquan/aitu/commit/f000e29))
- 优化提示词 ([530ad3a](https://github.com/ljquan/aitu/commit/530ad3a))
- 优化 ([6121a6a](https://github.com/ljquan/aitu/commit/6121a6a))
- 并行 ([fd793c7](https://github.com/ljquan/aitu/commit/fd793c7))
- 优化工作流 ([0dbd619](https://github.com/ljquan/aitu/commit/0dbd619))
- 优化 ([5bfcf88](https://github.com/ljquan/aitu/commit/5bfcf88))
- 优化输入框 ([7263289](https://github.com/ljquan/aitu/commit/7263289))
- 优化参数 ([b46af91](https://github.com/ljquan/aitu/commit/b46af91))
- 优化样式 ([560ee6f](https://github.com/ljquan/aitu/commit/560ee6f))
- 样式优化 ([726d27b](https://github.com/ljquan/aitu/commit/726d27b))
- 优化 ([1d24b51](https://github.com/ljquan/aitu/commit/1d24b51))
- 添加文本模型设置 ([41670cf](https://github.com/ljquan/aitu/commit/41670cf))
- 优化 ([441db62](https://github.com/ljquan/aitu/commit/441db62))
- 优化输入框 ([b0fe73c](https://github.com/ljquan/aitu/commit/b0fe73c))
- 优化提示词 ([50c06be](https://github.com/ljquan/aitu/commit/50c06be))
- 优化输入框交互 ([f0017b8](https://github.com/ljquan/aitu/commit/f0017b8))
- 优化输入框 ([0d3624d](https://github.com/ljquan/aitu/commit/0d3624d))
- 优化 ([e18c059](https://github.com/ljquan/aitu/commit/e18c059))
- 样式优化 ([620940d](https://github.com/ljquan/aitu/commit/620940d))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- wj <wj@MacBook-Pro.local>
- gongchengtu <1817063960@qq.com>

## 0.4.0 (2026-01-05)

### 🚀 Features

- 添加版本更新提示组件和交互逻辑 ([9084f9a](https://github.com/ljquan/aitu/commit/9084f9a))
- 更新版本信息和初始化数据加载方式 ([e0fed52](https://github.com/ljquan/aitu/commit/e0fed52))
- 优化 WorkZone 位置策略 ([604ef48](https://github.com/ljquan/aitu/commit/604ef48))
- 添加长视频生成与恢复功能 ([c7c3fa2](https://github.com/ljquan/aitu/commit/c7c3fa2))
- 发送工作流时不自动展开 ChatDrawer ([3275cd1](https://github.com/ljquan/aitu/commit/3275cd1))
- 添加 WorkZone 画布元素显示工作流进度 ([74ef571](https://github.com/ljquan/aitu/commit/74ef571))
- 添加 @ 触发模型选择和固定底栏布局 ([d409912](https://github.com/ljquan/aitu/commit/d409912))
- 添加长视频生成功能 ([2f5d84f](https://github.com/ljquan/aitu/commit/2f5d84f))
- 添加共享选中内容预览组件并重构相关代码 ([2a8be45](https://github.com/ljquan/aitu/commit/2a8be45))
- 增强文本选择和复制功能并优化布局 ([655e5a3](https://github.com/ljquan/aitu/commit/655e5a3))
- 添加SVG工具支持矢量图插入画布 ([404e8e1](https://github.com/ljquan/aitu/commit/404e8e1))
- 添加AI分析内容显示和工作流消息优化 ([8cd8277](https://github.com/ljquan/aitu/commit/8cd8277))
- 添加插入元素后自动滚动到视口的功能 ([1671c60](https://github.com/ljquan/aitu/commit/1671c60))

### 🩹 Fixes

- WorkZone 元素不触发 popup-toolbar ([bc6298b](https://github.com/ljquan/aitu/commit/bc6298b))
- 优化白边检测逻辑并改进图片分割策略 ([c864077](https://github.com/ljquan/aitu/commit/c864077))
- 修复工具栏按钮在打开状态时仍显示标题的问题 ([8973b8b](https://github.com/ljquan/aitu/commit/8973b8b))
- 优化宫格图分割逻辑，避免误裁透明背景角色 ([795fd28](https://github.com/ljquan/aitu/commit/795fd28))
- 修复消息提示实例未正确关闭的问题 ([0a5fbb9](https://github.com/ljquan/aitu/commit/0a5fbb9))

### 🔧 Chores

- 将package-lock.json添加到.gitignore中 ([c9730ac](https://github.com/ljquan/aitu/commit/c9730ac))
- refactor: 移除未使用的ffmpeg依赖和视频合并服务 ([51ecdb2](https://github.com/ljquan/aitu/commit/51ecdb2))
- docs: 更新 CLAUDE.md 添加 WorkZone 文档 ([3f9d194](https://github.com/ljquan/aitu/commit/3f9d194))
- 优化 ([d785603](https://github.com/ljquan/aitu/commit/d785603))
- 优化宫格拆图 ([47e4ca7](https://github.com/ljquan/aitu/commit/47e4ca7))
- 优化宫格图 ([acf2372](https://github.com/ljquan/aitu/commit/acf2372))
- 优化历史提示词展示 ([cf0f174](https://github.com/ljquan/aitu/commit/cf0f174))
- 优化提示词 ([cdd5ac4](https://github.com/ljquan/aitu/commit/cdd5ac4))
- 优化拆分 ([7c4d4fe](https://github.com/ljquan/aitu/commit/7c4d4fe))
- 优化拆图 ([39885a1](https://github.com/ljquan/aitu/commit/39885a1))
- 优化拆图 ([e072ca0](https://github.com/ljquan/aitu/commit/e072ca0))
- 照片墙改成灵感图 ([e3f1d9a](https://github.com/ljquan/aitu/commit/e3f1d9a))
- 优化拆分 ([0d1ebce](https://github.com/ljquan/aitu/commit/0d1ebce))
- 优化模型注入 ([97d113e](https://github.com/ljquan/aitu/commit/97d113e))
- 优化对话抽屉 ([d7b1714](https://github.com/ljquan/aitu/commit/d7b1714))
- 优化抽屉输入框 ([cfb87f3](https://github.com/ljquan/aitu/commit/cfb87f3))
- 对话抽屉换到右侧 ([50c8e72](https://github.com/ljquan/aitu/commit/50c8e72))
- 优化去白边 ([94d2e24](https://github.com/ljquan/aitu/commit/94d2e24))
- 优化 ([a49eba8](https://github.com/ljquan/aitu/commit/a49eba8))
- 优化拆分 ([49828b8](https://github.com/ljquan/aitu/commit/49828b8))
- 优化拆图 ([22afb18](https://github.com/ljquan/aitu/commit/22afb18))
- 添加照片墙 ([24f1bee](https://github.com/ljquan/aitu/commit/24f1bee))
- 修改概念 ([5213d28](https://github.com/ljquan/aitu/commit/5213d28))
- 下载 ([9f924a1](https://github.com/ljquan/aitu/commit/9f924a1))
- 优化切图 ([f299821](https://github.com/ljquan/aitu/commit/f299821))
- 优化 ([99d3342](https://github.com/ljquan/aitu/commit/99d3342))
- 生成照片墙 ([b17cf46](https://github.com/ljquan/aitu/commit/b17cf46))
- 优化图、视频mcp ([8f2cee5](https://github.com/ljquan/aitu/commit/8f2cee5))
- 添加思维导图mcp ([ab51889](https://github.com/ljquan/aitu/commit/ab51889))
- 增加冷启动提示词 ([c705055](https://github.com/ljquan/aitu/commit/c705055))
- 修复对话 ([a11d401](https://github.com/ljquan/aitu/commit/a11d401))
- 优化指令 ([9f8ad01](https://github.com/ljquan/aitu/commit/9f8ad01))
- 优化工作流实现 ([ba00566](https://github.com/ljquan/aitu/commit/ba00566))
- 优化点击 ([904a6c5](https://github.com/ljquan/aitu/commit/904a6c5))
- 优化 ([f096ce2](https://github.com/ljquan/aitu/commit/f096ce2))
- 优化提示词 ([f281595](https://github.com/ljquan/aitu/commit/f281595))
- 优化数量选择 ([18ca11d](https://github.com/ljquan/aitu/commit/18ca11d))
- 优化多任务 ([61c615b](https://github.com/ljquan/aitu/commit/61c615b))
- 优化删除 ([f000e29](https://github.com/ljquan/aitu/commit/f000e29))
- 优化提示词 ([530ad3a](https://github.com/ljquan/aitu/commit/530ad3a))
- 优化 ([6121a6a](https://github.com/ljquan/aitu/commit/6121a6a))
- 并行 ([fd793c7](https://github.com/ljquan/aitu/commit/fd793c7))
- 优化工作流 ([0dbd619](https://github.com/ljquan/aitu/commit/0dbd619))
- 优化 ([5bfcf88](https://github.com/ljquan/aitu/commit/5bfcf88))
- 优化输入框 ([7263289](https://github.com/ljquan/aitu/commit/7263289))
- 优化参数 ([b46af91](https://github.com/ljquan/aitu/commit/b46af91))
- 优化样式 ([560ee6f](https://github.com/ljquan/aitu/commit/560ee6f))
- 样式优化 ([726d27b](https://github.com/ljquan/aitu/commit/726d27b))
- 优化 ([1d24b51](https://github.com/ljquan/aitu/commit/1d24b51))
- 添加文本模型设置 ([41670cf](https://github.com/ljquan/aitu/commit/41670cf))
- 优化 ([441db62](https://github.com/ljquan/aitu/commit/441db62))
- 优化输入框 ([b0fe73c](https://github.com/ljquan/aitu/commit/b0fe73c))
- 优化提示词 ([50c06be](https://github.com/ljquan/aitu/commit/50c06be))
- 优化输入框交互 ([f0017b8](https://github.com/ljquan/aitu/commit/f0017b8))
- 优化输入框 ([0d3624d](https://github.com/ljquan/aitu/commit/0d3624d))
- 优化 ([e18c059](https://github.com/ljquan/aitu/commit/e18c059))
- 样式优化 ([620940d](https://github.com/ljquan/aitu/commit/620940d))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- wj <wj@MacBook-Pro.local>
- liquidliang <ljquan@qq.com>

## 0.3.3 (2025-12-29)

### 🚀 Features

- 新增视图模式切换和性能优化 ([c8eecf5](https://github.com/ljquan/aitu/commit/c8eecf5))
- 优化场景时长选择器和角色提取限制 ([12441ee](https://github.com/ljquan/aitu/commit/12441ee))
- 优化故事场景模式UI和配置 ([9ff294a](https://github.com/ljquan/aitu/commit/9ff294a))
- 添加 Sora-2 角色提取与复用功能 ([26aefb0](https://github.com/ljquan/aitu/commit/26aefb0))
- 添加 Sora-2 故事场景模式支持 ([7155c5b](https://github.com/ljquan/aitu/commit/7155c5b))
- 任务卡片添加打开链接功能 ([07bb0b3](https://github.com/ljquan/aitu/commit/07bb0b3))
- 优化图片加载体验 ([3fba487](https://github.com/ljquan/aitu/commit/3fba487))
- 任务创建时间改为绝对时间格式 ([fc5a864](https://github.com/ljquan/aitu/commit/fc5a864))

### 🩹 Fixes

- 添加 @tanstack/react-virtual 到根目录依赖解决构建问题 ([8a08d58](https://github.com/ljquan/aitu/commit/8a08d58))
- 优化视频生成参考图多图处理和模型切换保留 ([e1782e8](https://github.com/ljquan/aitu/commit/e1782e8))
- 虚拟滚动优化和视图模式持久化 ([af2978c](https://github.com/ljquan/aitu/commit/af2978c))
- 优化角色任务队列展示和预览功能 ([718052a](https://github.com/ljquan/aitu/commit/718052a))
- 修复角色接口兼容任务队列请求 ([e1b8562](https://github.com/ljquan/aitu/commit/e1b8562))
- 角色加载优化 ([4c4879b](https://github.com/ljquan/aitu/commit/4c4879b))
- 修复角色提取功能问题 ([8a121ba](https://github.com/ljquan/aitu/commit/8a121ba))
- 修复创建角色缓存问题 ([6372a89](https://github.com/ljquan/aitu/commit/6372a89))
- 故事板支持@角色 ([3f18b8e](https://github.com/ljquan/aitu/commit/3f18b8e))
- 角色提示优化 ([4eafc4d](https://github.com/ljquan/aitu/commit/4eafc4d))
- 故事场景模式优化 ([dc90986](https://github.com/ljquan/aitu/commit/dc90986))
- 修复重试时立即报超时的问题 ([1f2df99](https://github.com/ljquan/aitu/commit/1f2df99))
- 优化下载逻辑，优先使用本地缓存并增加重试机制 ([0c03c5d](https://github.com/ljquan/aitu/commit/0c03c5d))

### 🔧 Chores

- 同步 package-lock.json 添加 @tanstack/react-virtual ([69fe1d5](https://github.com/ljquan/aitu/commit/69fe1d5))
- 添加 pnpm-lock.yaml 修复 Netlify 构建 ([c74f2ed](https://github.com/ljquan/aitu/commit/c74f2ed))
- refactor(character): 代码质量优化 ([3918571](https://github.com/ljquan/aitu/commit/3918571))
- 不同模型 @ 显示区分 ([6e1d8be](https://github.com/ljquan/aitu/commit/6e1d8be))
- 优化图标 ([5c82e04](https://github.com/ljquan/aitu/commit/5c82e04))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>

## 0.3.2 (2025-12-23)

### 🔧 Chores

- 添加域名处理 ([b227909](https://github.com/ljquan/aitu/commit/b227909))
- v0.3.1 ([0f639c3](https://github.com/ljquan/aitu/commit/0f639c3))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.3.1 (2025-12-23)

### 🚀 Features

- 优化AI图片和AI视频图标样式 ([237695f](https://github.com/ljquan/aitu/commit/237695f))
- 优化工具栏图标布局和AI图标样式 ([00392d4](https://github.com/ljquan/aitu/commit/00392d4))
- 优化按钮布局 close #42 ([80ed227](https://github.com/ljquan/aitu/commit/80ed227))
- 将模式切换按钮移至 WinBox 标题栏 ([4c8617b](https://github.com/ljquan/aitu/commit/4c8617b))
- 添加新 VIP 图片模型并优化模型选择器 ([64ca946](https://github.com/ljquan/aitu/commit/64ca946))
- 优化表格交互体验 ([093681e](https://github.com/ljquan/aitu/commit/093681e))
- 生成中状态显示在已完成图片后面 ([3a81415](https://github.com/ljquan/aitu/commit/3a81415))
- 智能下载功能（单张直接下载，多张打包zip） ([5ba9ab7](https://github.com/ljquan/aitu/commit/5ba9ab7))
- 添加图片预览导航和生成警告功能 ([b02f181](https://github.com/ljquan/aitu/commit/b02f181))
- 添加模式记忆功能 ([05a16ff](https://github.com/ljquan/aitu/commit/05a16ff))
- 改进错误信息显示 ([a3d4d41](https://github.com/ljquan/aitu/commit/a3d4d41))
- 添加本地缓存和修复光标位置 ([ab2cba7](https://github.com/ljquan/aitu/commit/ab2cba7))
- 改进单元格交互体验 ([f8a88e5](https://github.com/ljquan/aitu/commit/f8a88e5))
- 改进数量单元格的交互体验 ([5e86ff4](https://github.com/ljquan/aitu/commit/5e86ff4))
- 切换到批量模式时自动最大化窗口 ([6dc6283](https://github.com/ljquan/aitu/commit/6dc6283))
- 改进添加行UI和下载模板功能 ([4f9e2b8](https://github.com/ljquan/aitu/commit/4f9e2b8))
- 添加图片预览放大、批量下载和模型选择功能 ([ab23c7d](https://github.com/ljquan/aitu/commit/ab23c7d))
- 添加 Excel 导入导出功能 ([7afe54b](https://github.com/ljquan/aitu/commit/7afe54b))
- 支持选择批量导入的起始行 ([c322a95](https://github.com/ljquan/aitu/commit/c322a95))
- 添加批量上传导入表格功能 ([59d0c81](https://github.com/ljquan/aitu/commit/59d0c81))
- 添加复选框列用于行选择 ([b373b8f](https://github.com/ljquan/aitu/commit/b373b8f))
- 添加预览列、选择功能和仅生成选中行 ([efb9253](https://github.com/ljquan/aitu/commit/efb9253))
- 将批量出图集成到 AI 图片生成对话框 ([51a8141](https://github.com/ljquan/aitu/commit/51a8141))
- 重构批量任务提交逻辑，添加批次参数避免重复检测 ([9885195](https://github.com/ljquan/aitu/commit/9885195))
- 增强批量出图功能 ([c608c09](https://github.com/ljquan/aitu/commit/c608c09))
- 添加批量出图工具及图片库功能 ([5b943db](https://github.com/ljquan/aitu/commit/5b943db))

### 🩹 Fixes

- 修复批量生成预览图首次加载损坏问题 ([1ba7a93](https://github.com/ljquan/aitu/commit/1ba7a93))
- 修复无API Key时批量生成弹出多个弹窗问题 ([0613708](https://github.com/ljquan/aitu/commit/0613708))
- 修复填充柄与选择拖拽冲突问题 ([f128f28](https://github.com/ljquan/aitu/commit/f128f28))
- 优化画廊和下载功能 ([af0e7d9](https://github.com/ljquan/aitu/commit/af0e7d9))
- 修复带内容进入时自动放大问题 ([d60a25d](https://github.com/ljquan/aitu/commit/d60a25d))
- 修复多项交互问题 ([c94283b](https://github.com/ljquan/aitu/commit/c94283b))
- 修复单元格选择和复制粘贴功能 ([faa24b9](https://github.com/ljquan/aitu/commit/faa24b9))
- 点击失败行预览单元格时选中行复选框 ([382e94b](https://github.com/ljquan/aitu/commit/382e94b))
- 统一错误显示格式与任务队列一致 ([f2c1732](https://github.com/ljquan/aitu/commit/f2c1732))
- 修复编辑模式下单击退出编辑的问题 ([796c5ec](https://github.com/ljquan/aitu/commit/796c5ec))
- 修正单元格交互为Excel风格 ([335cbb9](https://github.com/ljquan/aitu/commit/335cbb9))
- 添加 globalIndex 确保每个子任务哈希唯一 ([ed6c92b](https://github.com/ljquan/aitu/commit/ed6c92b))

### 🔧 Chores

- 优化z-index ([94e887d](https://github.com/ljquan/aitu/commit/94e887d))
- style(batch-image): 将批量出图按钮改为文字链接样式 ([43e9871](https://github.com/ljquan/aitu/commit/43e9871))
- refactor(batch-image): 移除状态、预览、操作列，简化为纯提交工具 ([735e736](https://github.com/ljquan/aitu/commit/735e736))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>
- likeusewin10 <1375280732@qq.com>

## 0.3.0 (2025-12-16)

### 🩹 Fixes

- 添加 .npmrc 解决 CI 依赖安装冲突 ([0b8f8e1](https://github.com/ljquan/aitu/commit/0b8f8e1))
- 修复winbox 中任务显示不正常 ([3f16f13](https://github.com/ljquan/aitu/commit/3f16f13))

### 🔧 Chores

- 指示小优化 ([d90971f](https://github.com/ljquan/aitu/commit/d90971f))
- 素材库位置优化 ([5e2e0ea](https://github.com/ljquan/aitu/commit/5e2e0ea))
- 工具箱优化 ([794ca89](https://github.com/ljquan/aitu/commit/794ca89))
- 更换chat生图接口为 image接口、修复素材库边距 ([4757992](https://github.com/ljquan/aitu/commit/4757992))
- 优化教程 ([f927878](https://github.com/ljquan/aitu/commit/f927878))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.2.15 (2025-12-13)

### 🚀 Features

- 素材库批量删除支持 ([5440dae](https://github.com/ljquan/aitu/commit/5440dae))
- 素材库初版实现 ([9acfaa4](https://github.com/ljquan/aitu/commit/9acfaa4))
- 实现多功能工具箱系统 ([2ece4c6](https://github.com/ljquan/aitu/commit/2ece4c6))
- 优化工具栏和AI生成功能 ([51e6f5c](https://github.com/ljquan/aitu/commit/51e6f5c))
- 优化项目抽屉UI和图标设计 ([615f4f6](https://github.com/ljquan/aitu/commit/615f4f6))
- workspace项目管理系统及首次访问默认数据 ([a6d6a84](https://github.com/ljquan/aitu/commit/a6d6a84))

### 🩹 Fixes

- 素材库移动端优化 ([cad4025](https://github.com/ljquan/aitu/commit/cad4025))
- 素材填入优化 ([6dfbe94](https://github.com/ljquan/aitu/commit/6dfbe94))
- 视频加载修复 ([9e7a5f7](https://github.com/ljquan/aitu/commit/9e7a5f7))
- 素材库样式修复 ([34b36a5](https://github.com/ljquan/aitu/commit/34b36a5))
- 修复视频模型切换参数同步问题 ([53a653e](https://github.com/ljquan/aitu/commit/53a653e))

### 🔧 Chores

- bump version to 0.2.14 ([66e8bba](https://github.com/ljquan/aitu/commit/66e8bba))
- 优化交互 ([a961727](https://github.com/ljquan/aitu/commit/a961727))
- 优化缩放 ([c605f5a](https://github.com/ljquan/aitu/commit/c605f5a))
- 优化工具 ([62d7d76](https://github.com/ljquan/aitu/commit/62d7d76))
- docs: 添加openspec ([663998f](https://github.com/ljquan/aitu/commit/663998f))
- docs(009-media-library): 添加媒体库功能规划文档 ([9c6c35a](https://github.com/ljquan/aitu/commit/9c6c35a))
- refactor(analytics): 将 Umami 分析替换为 PostHog ([c0b7069](https://github.com/ljquan/aitu/commit/c0b7069))

### ❤️  Thank You

- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>

## 0.2.14 (2025-12-10)

### 🚀 Features

- 优化工具栏和AI生成功能 ([51e6f5c](https://github.com/ljquan/aitu/commit/51e6f5c))
- 优化项目抽屉UI和图标设计 ([615f4f6](https://github.com/ljquan/aitu/commit/615f4f6))
- workspace项目管理系统及首次访问默认数据 ([a6d6a84](https://github.com/ljquan/aitu/commit/a6d6a84))

### 🩹 Fixes

- 修复视频模型切换参数同步问题 ([53a653e](https://github.com/ljquan/aitu/commit/53a653e))

### 🔧 Chores

- refactor(analytics): 将 Umami 分析替换为 PostHog ([c0b7069](https://github.com/ljquan/aitu/commit/c0b7069))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.2.13 (2025-12-06)

### 🚀 Features

- 实现智能升级机制,避免中断用户活跃请求 ([484797a](https://github.com/ljquan/aitu/commit/484797a))

### 🔧 Chores

- refactor(dialog): 重构AI生成对话框为任务列表驱动的工作流 ([3612715](https://github.com/ljquan/aitu/commit/3612715))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.12 (2025-12-06)

### 🩹 Fixes

- 优化静态资源缓存策略并修复HTML版本问题 ([6550953](https://github.com/ljquan/aitu/commit/6550953))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.11 (2025-12-05)

### 🔧 Chores

- 优化升级逻辑 ([d03710d](https://github.com/ljquan/aitu/commit/d03710d))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.10 (2025-12-05)

### 🔧 Chores

- 修复bug ([8e055a8](https://github.com/ljquan/aitu/commit/8e055a8))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.9 (2025-12-05)

### 🚀 Features

- 统一应用版本管理并添加全局版本变量 ([b57d947](https://github.com/ljquan/aitu/commit/b57d947))
- add declarative tracking specification and task breakdown ([53f18c7](https://github.com/ljquan/aitu/commit/53f18c7))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>

## 0.2.8 (2025-12-05)

### 🚀 Features

- 添加聊天模型选择器组件 ([289857a](https://github.com/ljquan/aitu/commit/289857a))
- 添加文本对话抽屉 ([8ad019e](https://github.com/ljquan/aitu/commit/8ad019e))
- 优化布局 #12 ([28d2ee3](https://github.com/ljquan/aitu/commit/28d2ee3))

### 🩹 Fixes

- 修复WinBox内容挂载导致的DOM节点引用错误 ([22c6c3d](https://github.com/ljquan/aitu/commit/22c6c3d))
- 修复对话抽屉API key检查和弹窗层级问题 ([06cf9d5](https://github.com/ljquan/aitu/commit/06cf9d5))
- 修复统一工具栏与任务按钮位置冲突 ([88f2c4c](https://github.com/ljquan/aitu/commit/88f2c4c))
- 修复视频插入画板后不显示的问题 ([91bdfa4](https://github.com/ljquan/aitu/commit/91bdfa4))
- 优化缓存机制、工具栏交互和AI图片生成功能 ([b606db4](https://github.com/ljquan/aitu/commit/b606db4))

### 🔧 Chores

- bump version to 0.2.7 ([8f926c5](https://github.com/ljquan/aitu/commit/8f926c5))
- bump version to 0.2.6 ([4774a24](https://github.com/ljquan/aitu/commit/4774a24))
- 优化样式 ([d12681d](https://github.com/ljquan/aitu/commit/d12681d))
- 优化颜色 ([b94d6ab](https://github.com/ljquan/aitu/commit/b94d6ab))
- 优化示例 ([964a8a8](https://github.com/ljquan/aitu/commit/964a8a8))
- 优化构建 ([b0d9653](https://github.com/ljquan/aitu/commit/b0d9653))
- 优化build ([152b9ca](https://github.com/ljquan/aitu/commit/152b9ca))
- 添加type ([966ce2e](https://github.com/ljquan/aitu/commit/966ce2e))
- 调整层级 ([57b4a98](https://github.com/ljquan/aitu/commit/57b4a98))
- 布局优化2 ([a8a9faa](https://github.com/ljquan/aitu/commit/a8a9faa))
- 布局优化1 ([ecf8d8d](https://github.com/ljquan/aitu/commit/ecf8d8d))
- 提高超时时间 ([620d5c2](https://github.com/ljquan/aitu/commit/620d5c2))
- 优化上报&弹窗 ([211fc9f](https://github.com/ljquan/aitu/commit/211fc9f))
- docs: 完善项目文档和工具链 ([4dae671](https://github.com/ljquan/aitu/commit/4dae671))
- 添加filesystem兜底 ([622ce19](https://github.com/ljquan/aitu/commit/622ce19))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>

## 0.2.7 (2025-12-04)

### 🚀 Features

- 添加聊天模型选择器组件 ([289857a](https://github.com/ljquan/aitu/commit/289857a))
- 添加文本对话抽屉 ([8ad019e](https://github.com/ljquan/aitu/commit/8ad019e))
- 优化布局 #12 ([28d2ee3](https://github.com/ljquan/aitu/commit/28d2ee3))

### 🩹 Fixes

- 修复对话抽屉API key检查和弹窗层级问题 ([06cf9d5](https://github.com/ljquan/aitu/commit/06cf9d5))
- 修复统一工具栏与任务按钮位置冲突 ([88f2c4c](https://github.com/ljquan/aitu/commit/88f2c4c))
- 修复视频插入画板后不显示的问题 ([91bdfa4](https://github.com/ljquan/aitu/commit/91bdfa4))
- 优化缓存机制、工具栏交互和AI图片生成功能 ([b606db4](https://github.com/ljquan/aitu/commit/b606db4))

### 🔧 Chores

- bump version to 0.2.6 ([4774a24](https://github.com/ljquan/aitu/commit/4774a24))
- 布局优化2 ([a8a9faa](https://github.com/ljquan/aitu/commit/a8a9faa))
- 布局优化1 ([ecf8d8d](https://github.com/ljquan/aitu/commit/ecf8d8d))
- 提高超时时间 ([620d5c2](https://github.com/ljquan/aitu/commit/620d5c2))
- docs: 完善项目文档和工具链 ([4dae671](https://github.com/ljquan/aitu/commit/4dae671))
- 添加filesystem兜底 ([622ce19](https://github.com/ljquan/aitu/commit/622ce19))

### ❤️  Thank You

- gongchengtu <1817063960@qq.com>
- liquidliang <ljquan@qq.com>
- liquid <ljquan@qq.com>

## 0.2.6 (2025-12-02)

### 🚀 Features

- 优化布局 #12 ([28d2ee3](https://github.com/ljquan/aitu/commit/28d2ee3))

### 🩹 Fixes

- 修复视频插入画板后不显示的问题 ([91bdfa4](https://github.com/ljquan/aitu/commit/91bdfa4))
- 优化缓存机制、工具栏交互和AI图片生成功能 ([b606db4](https://github.com/ljquan/aitu/commit/b606db4))

### 🔧 Chores

- bump version to 0.2.4 ([bb46198](https://github.com/ljquan/aitu/commit/bb46198))
- 添加filesystem兜底 ([622ce19](https://github.com/ljquan/aitu/commit/622ce19))
- 优化缓存 ([72ca629](https://github.com/ljquan/aitu/commit/72ca629))

### ❤️  Thank You

- liquidliang <ljquan@qq.com>
- gongchengtu <1817063960@qq.com>
- liquid <ljquan@qq.com>

## 0.2.4 (2025-11-30)

### 🔧 Chores

- 优化缓存 ([72ca629](https://github.com/ljquan/aitu/commit/72ca629))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.3 (2025-11-30)

### 🔧 Chores

- 添加图片加载的重试组件 ([f365f84](https://github.com/ljquan/aitu/commit/f365f84))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.2 (2025-11-30)

### 🔧 Chores

- choice: 优化changelog ([9b47e75](https://github.com/ljquan/aitu/commit/9b47e75))
- 优化缓存和版本管理 ([cde96d4](https://github.com/ljquan/aitu/commit/cde96d4))

### ❤️  Thank You

- liquid <ljquan@qq.com>

## 0.2.1 (2025-08-06)


### 🩹 Fixes

- **hotkey:** assign t as hotkey to create text element ([#192](https://github.com/plait-board/drawnix/pull/192))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.2.0 (2025-08-06)

This was a version bump only, there were no code changes.

## 0.1.4 (2025-08-06)

This was a version bump only, there were no code changes.

## 0.1.3 (2025-08-06)


### 🩹 Fixes

- **hotkey:** prevent hotkey when  type normally ([#189](https://github.com/plait-board/drawnix/pull/189))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.1.2 (2025-08-06)


### 🚀 Features

- **creation:** support creation mode hotkey #183 ([#185](https://github.com/plait-board/drawnix/pull/185), [#183](https://github.com/plait-board/drawnix/issues/183))
- **mind:** bump plait into 0.82.0 to improve the experience of mind ([f904594](https://github.com/plait-board/drawnix/commit/f904594))
- **viewer:** support image which in mind node view #125 ([#125](https://github.com/plait-board/drawnix/issues/125))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.1.1 (2025-07-10)


### 🩹 Fixes

- **text:** resolve text can not auto break line #173 #169 ([#173](https://github.com/plait-board/drawnix/issues/173), [#169](https://github.com/plait-board/drawnix/issues/169))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.1.0 (2025-07-02)


### 🚀 Features

- import styles ([ecfe3cd](https://github.com/plait-board/drawnix/commit/ecfe3cd))
- add script and update ci ([147c028](https://github.com/plait-board/drawnix/commit/147c028))
- bump plait into 0.62.0-next.7 ([7ab4003](https://github.com/plait-board/drawnix/commit/7ab4003))
- add main menu ([#14](https://github.com/plait-board/drawnix/pull/14))
- improve active-toolbar ([fd19725](https://github.com/plait-board/drawnix/commit/fd19725))
- rename active-toolbar to popup-toolbar and modify tool-button ([aa06c7e](https://github.com/plait-board/drawnix/commit/aa06c7e))
- support opacity for  color property ([#16](https://github.com/plait-board/drawnix/pull/16))
- support local storage ([9c0e652](https://github.com/plait-board/drawnix/commit/9c0e652))
- add product_showcase bump plait into 0.69.0 ([61fe571](https://github.com/plait-board/drawnix/commit/61fe571))
- add sitemap ([3b9d9a3](https://github.com/plait-board/drawnix/commit/3b9d9a3))
- improve pinch zoom ([#77](https://github.com/plait-board/drawnix/pull/77))
- bump plait into 0.76.0 and handle break changes ([#90](https://github.com/plait-board/drawnix/pull/90))
- improve README ([9e0190d](https://github.com/plait-board/drawnix/commit/9e0190d))
- add dependencies for packages ([6d89b32](https://github.com/plait-board/drawnix/commit/6d89b32))
- init dialog and mermaid-to-dialog ([6ff70b9](https://github.com/plait-board/drawnix/commit/6ff70b9))
- support save as json from hotkey ([120dffa](https://github.com/plait-board/drawnix/commit/120dffa))
- support sub menu and export jpg ([#132](https://github.com/plait-board/drawnix/pull/132))
- improve link popup state ([#147](https://github.com/plait-board/drawnix/pull/147))
- improve seo ([#148](https://github.com/plait-board/drawnix/pull/148))
- **active-toolbar:** add active toolbar ([7e737a2](https://github.com/plait-board/drawnix/commit/7e737a2))
- **active-toolbar:** support font color property ([4b2d964](https://github.com/plait-board/drawnix/commit/4b2d964))
- **app:** use localforage to storage main board content #122 ([#122](https://github.com/plait-board/drawnix/issues/122))
- **app-toolbar:** support undo/redo operation ([50f8831](https://github.com/plait-board/drawnix/commit/50f8831))
- **app-toolbar:** add trash and duplicate in app-toolbar ([#28](https://github.com/plait-board/drawnix/pull/28))
- **clean-board:** complete clean board ([#124](https://github.com/plait-board/drawnix/pull/124))
- **clean-confirm:** autoFocus ok button ([582172a](https://github.com/plait-board/drawnix/commit/582172a))
- **color-picker:** support merge operations for update opacity #4 ([#45](https://github.com/plait-board/drawnix/pull/45), [#4](https://github.com/plait-board/drawnix/issues/4))
- **component:** improve the onXXXChange feature for drawnix component #79 ([#79](https://github.com/plait-board/drawnix/issues/79))
- **component:** add afterInit to expose board instance ([23d91dc](https://github.com/plait-board/drawnix/commit/23d91dc))
- **component:** support update value from drawnix component outside ([#103](https://github.com/plait-board/drawnix/pull/103))
- **component:** fit viewport after children updated ([#104](https://github.com/plait-board/drawnix/pull/104))
- **creation-toolbar:** support long-press triggers drag selection an… ([#78](https://github.com/plait-board/drawnix/pull/78))
- **creation-toolbar:** remove default action when click shape and arrow icon in creation toolbar improve tool-button ([a46c2df](https://github.com/plait-board/drawnix/commit/a46c2df))
- **draw:** bump plait into 0.75.0-next.0 and support fine-grained selection ([#69](https://github.com/plait-board/drawnix/pull/69))
- **draw-toolbar:** add draw toolbar ([#9](https://github.com/plait-board/drawnix/pull/9))
- **draw-toolbar:** add shape and arrow panel for draw-toolbar #10 ([#12](https://github.com/plait-board/drawnix/pull/12), [#10](https://github.com/plait-board/drawnix/issues/10))
- **drawnix:** init drawnix package ([397d865](https://github.com/plait-board/drawnix/commit/397d865))
- **drawnix:** export utils ([#105](https://github.com/plait-board/drawnix/pull/105))
- **drawnix-board:** initialize drawnix board ([117e5a8](https://github.com/plait-board/drawnix/commit/117e5a8))
- **fill:** split fill color and fill opacity setting ([#53](https://github.com/plait-board/drawnix/pull/53))
- **flowchart:** add terminal shape element ([#80](https://github.com/plait-board/drawnix/pull/80))
- **freehand:** initialize freehand #2 ([#2](https://github.com/plait-board/drawnix/issues/2))
- **freehand:** apply gaussianSmooth to freehand curve ([#47](https://github.com/plait-board/drawnix/pull/47))
- **freehand:** update stroke width to 2 and optimize freehand end points ([#50](https://github.com/plait-board/drawnix/pull/50))
- **freehand:** improve freehand experience ([#51](https://github.com/plait-board/drawnix/pull/51))
- **freehand:** add FreehandSmoother to optimize freehand curve ([#62](https://github.com/plait-board/drawnix/pull/62))
- **freehand:** optimize freehand curve by stylus features ([#63](https://github.com/plait-board/drawnix/pull/63))
- **freehand:** freehand support theme ([b7c7965](https://github.com/plait-board/drawnix/commit/b7c7965))
- **freehand:** support closed freehand and add popup for freehand ([#68](https://github.com/plait-board/drawnix/pull/68))
- **freehand:** bump plait into 0.75.0-next.9 and resolve freehand unexpected resize-handle after moving freehand elements ([#84](https://github.com/plait-board/drawnix/pull/84))
- **hotkey:** support export png hotkey ([#30](https://github.com/plait-board/drawnix/pull/30))
- **image:** support free image element and support insert image at m… ([#95](https://github.com/plait-board/drawnix/pull/95))
- **image:** should hide popup toolbar when selected element include image ([#96](https://github.com/plait-board/drawnix/pull/96))
- **image:** support drag image to board to add image as draw element or mind node image ([#144](https://github.com/plait-board/drawnix/pull/144))
- **link:** improve link popup ([eba06e2](https://github.com/plait-board/drawnix/commit/eba06e2))
- **markdown-to-drawnix:** support markdown to drawnix mind map #134 ([#135](https://github.com/plait-board/drawnix/pull/135), [#134](https://github.com/plait-board/drawnix/issues/134))
- **menu:** support export to json file ([d0d6ca5](https://github.com/plait-board/drawnix/commit/d0d6ca5))
- **menu:** support load file action ([758aa6d](https://github.com/plait-board/drawnix/commit/758aa6d))
- **mermaid:** improve mermaid-to-drawnix ([a928ba1](https://github.com/plait-board/drawnix/commit/a928ba1))
- **mobile:** adapt mobile device ([7c0742f](https://github.com/plait-board/drawnix/commit/7c0742f))
- **pencil-mode:** add pencil mode and add drawnix context ([#76](https://github.com/plait-board/drawnix/pull/76))
- **pinch-zoom:** support pinch zoom for touch device ([#60](https://github.com/plait-board/drawnix/pull/60))
- **pinch-zoom:** improve pinch zoom functionality and support hand moving ([#75](https://github.com/plait-board/drawnix/pull/75))
- **popover:** add reusable popover and replace radix popover ([d30388a](https://github.com/plait-board/drawnix/commit/d30388a))
- **popup:** display icon when color is complete opacity ([#42](https://github.com/plait-board/drawnix/pull/42))
- **popup-toolbar:** support set branch color remove color property when select transparent #17 ([#17](https://github.com/plait-board/drawnix/issues/17))
- **popup-toolbar:** bump plait into 0.71.0 and mind node link stroke and node stroke support dashed/dotted style #22 ([#22](https://github.com/plait-board/drawnix/issues/22))
- **property:** support stroke style setting ([463c92a](https://github.com/plait-board/drawnix/commit/463c92a))
- **size-slider:** improve size-slider component ([780be9d](https://github.com/plait-board/drawnix/commit/780be9d))
- **text:** support soft break ([#39](https://github.com/plait-board/drawnix/pull/39))
- **text:** support update text from outside ([#58](https://github.com/plait-board/drawnix/pull/58))
- **text:** support insertSoftBreak for text #136 ([#136](https://github.com/plait-board/drawnix/issues/136))
- **theme-toolbar:** add theme selection toolbar for customizable themes ([dca0e33](https://github.com/plait-board/drawnix/commit/dca0e33))
- **toolbar:** support zoom toolbar ([76ef5d9](https://github.com/plait-board/drawnix/commit/76ef5d9))
- **web:** seo ([84cde4b](https://github.com/plait-board/drawnix/commit/84cde4b))
- **web:** add cloud.umami.is to track views ([#64](https://github.com/plait-board/drawnix/pull/64))
- **web:** modify initialize-data for adding freehand data ([#65](https://github.com/plait-board/drawnix/pull/65))
- **web:** add debug console ([#83](https://github.com/plait-board/drawnix/pull/83))
- **wrapper:** add wrapper component and context hook ([#6](https://github.com/plait-board/drawnix/pull/6))
- **zoom-toolbar:** support zoom menu ([cc6a6b8](https://github.com/plait-board/drawnix/commit/cc6a6b8))

### 🩹 Fixes

- remove theme-toolbar font-weight style ([#67](https://github.com/plait-board/drawnix/pull/67))
- revert package lock ([1aa9d42](https://github.com/plait-board/drawnix/commit/1aa9d42))
- fix pub issue ([156abcb](https://github.com/plait-board/drawnix/commit/156abcb))
- improve libs build ([9ddb6d9](https://github.com/plait-board/drawnix/commit/9ddb6d9))
- **app-toolbar:** correct app-toolbar style ([#106](https://github.com/plait-board/drawnix/pull/106))
- **arrow-line:** optimize the popup toolbar position when selected element is arrow line ([#70](https://github.com/plait-board/drawnix/pull/70))
- **board:** resolve mobile scrolling issue when resize or moving ([8fdca8e](https://github.com/plait-board/drawnix/commit/8fdca8e))
- **board:** bump plait into 0.69.1 deselect when text editing end refactor popup toolbar placement ([aef6d23](https://github.com/plait-board/drawnix/commit/aef6d23))
- **board:** use updateViewBox to fix board wobbles when dragging or resizing ([#94](https://github.com/plait-board/drawnix/pull/94))
- **color-picker:** support display 0 opacity ([#48](https://github.com/plait-board/drawnix/pull/48))
- **core:** bump plait into 0.79.1 to fix with-hand issue when press space key #141 ([#149](https://github.com/plait-board/drawnix/pull/149), [#141](https://github.com/plait-board/drawnix/issues/141))
- **creation-toolbar:** use pointerUp set basic pointer cause onChange do not fire on mobile bind pointermove/pointerup to viewportContainerRef to implement dnd on mobile #20 ([#20](https://github.com/plait-board/drawnix/issues/20))
- **creation-toolbar:** move out toolbar from board to avoid fired pointer down event when operating ([ddb6092](https://github.com/plait-board/drawnix/commit/ddb6092))
- **font-color:** fix color can not be assigned when current color is empty ([#55](https://github.com/plait-board/drawnix/pull/55))
- **freehand:** fix freehand creation issue(caused by throttleRAF) ([#40](https://github.com/plait-board/drawnix/pull/40))
- **mermaid:** bump mermaid-to-drawnix to 0.0.2 to fix text display issue ([33878d0](https://github.com/plait-board/drawnix/commit/33878d0))
- **mermaid-to-drawnix:** support group for insertToBoard ([e2f5056](https://github.com/plait-board/drawnix/commit/e2f5056))
- **mind:** remove branchColor property setting ([#46](https://github.com/plait-board/drawnix/pull/46))
- **property:** prevent set fill color opacity when color is none ([#56](https://github.com/plait-board/drawnix/pull/56))
- **react-board:** resolve text should not display in safari ([19fc20f](https://github.com/plait-board/drawnix/commit/19fc20f))
- **react-board:** support fit viewport after browser window resized ([96f4a0e](https://github.com/plait-board/drawnix/commit/96f4a0e))
- **size-slider:** correct size slider click handle can not fire ([#57](https://github.com/plait-board/drawnix/pull/57))
- **text:** fix composition input and abc input trembly issue ([#15](https://github.com/plait-board/drawnix/pull/15))
- **text:** resolve with-text build error ([#41](https://github.com/plait-board/drawnix/pull/41))
- **text:** fix text can not editing ([#52](https://github.com/plait-board/drawnix/pull/52))
- **text:** fix text can not display correctly on windows 10 chrome env #99 ([#100](https://github.com/plait-board/drawnix/pull/100), [#99](https://github.com/plait-board/drawnix/issues/99))
- **text:** allow scroll to show all text ([#156](https://github.com/plait-board/drawnix/pull/156))
- **text:** set whiteSpace: pre to avoid \n is ineffectual ([#165](https://github.com/plait-board/drawnix/pull/165))
- **use-board-event:** fix board event timing ([0d4a8f1](https://github.com/plait-board/drawnix/commit/0d4a8f1))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.0.4 (2025-04-15)


### 🚀 Features

- ci: a tiny docker image (#127) ([#122](https://github.com/plait-board/drawnix/pull/127))
- support save as json from hotkey ([120dffa](https://github.com/plait-board/drawnix/commit/120dffa))
- **app:** use localforage to storage main board content #122 ([#122](https://github.com/plait-board/drawnix/issues/122))
- **clean-board:** complete clean board ([#124](https://github.com/plait-board/drawnix/pull/124))

### 🩹 Fixes

- **react-board:** support fit viewport after browser window resized ([96f4a0e](https://github.com/plait-board/drawnix/commit/96f4a0e))

### ❤️  Thank You

- lurenyang418 @lurenyang418
- whyour @whyour
- pubuzhixing8 @pubuzhixing8

## 0.0.4-3 (2025-03-25)


### 🩹 Fixes

- improve libs build ([9ddb6d9](https://github.com/plait-board/drawnix/commit/9ddb6d9))
- **mermaid:** bump mermaid-to-drawnix to 0.0.2 to fix text display issue ([33878d0](https://github.com/plait-board/drawnix/commit/33878d0))

### ❤️  Thank You

- pubuzhixing8

## 0.0.4-2 (2025-03-19)


### 🚀 Features

- init dialog and mermaid-to-dialog ([6ff70b9](https://github.com/plait-board/drawnix/commit/6ff70b9))
- **mermaid:** improve mermaid-to-drawnix ([a928ba1](https://github.com/plait-board/drawnix/commit/a928ba1))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.0.4-1 (2025-03-16)

This was a version bump only, there were no code changes.

## 0.0.4-0 (2025-03-16)


### 🚀 Features

- add dependencies for packages ([6d89b32](https://github.com/plait-board/drawnix/commit/6d89b32))
- **component:** support update value from drawnix component outside ([#103](https://github.com/plait-board/drawnix/pull/103))
- **component:** fit viewport after children updated ([#104](https://github.com/plait-board/drawnix/pull/104))
- **drawnix:** export utils ([#105](https://github.com/plait-board/drawnix/pull/105))

### 🩹 Fixes

- **app-toolbar:** correct app-toolbar style ([#106](https://github.com/plait-board/drawnix/pull/106))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.0.3 (2025-03-14)


### 🩹 Fixes

- revert package lock ([1aa9d42](https://github.com/plait-board/drawnix/commit/1aa9d42))
- fix pub issue ([156abcb](https://github.com/plait-board/drawnix/commit/156abcb))
- **text:** fix text can not display correctly on windows 10 chrome env #99 ([#100](https://github.com/plait-board/drawnix/pull/100), [#99](https://github.com/plait-board/drawnix/issues/99))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.0.2 (2025-03-10)


### 🚀 Features

- improve README ([9e0190d](https://github.com/plait-board/drawnix/commit/9e0190d))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8

## 0.0.1 (2025-03-10)


### 🚀 Features

- import styles ([ecfe3cd](https://github.com/plait-board/drawnix/commit/ecfe3cd))
- add script and update ci ([147c028](https://github.com/plait-board/drawnix/commit/147c028))
- bump plait into 0.62.0-next.7 ([7ab4003](https://github.com/plait-board/drawnix/commit/7ab4003))
- add main menu ([#14](https://github.com/plait-board/drawnix/pull/14))
- improve active-toolbar ([fd19725](https://github.com/plait-board/drawnix/commit/fd19725))
- rename active-toolbar to popup-toolbar and modify tool-button ([aa06c7e](https://github.com/plait-board/drawnix/commit/aa06c7e))
- support opacity for  color property ([#16](https://github.com/plait-board/drawnix/pull/16))
- support local storage ([9c0e652](https://github.com/plait-board/drawnix/commit/9c0e652))
- add product_showcase bump plait into 0.69.0 ([61fe571](https://github.com/plait-board/drawnix/commit/61fe571))
- add sitemap ([3b9d9a3](https://github.com/plait-board/drawnix/commit/3b9d9a3))
- improve pinch zoom ([#77](https://github.com/plait-board/drawnix/pull/77))
- bump plait into 0.76.0 and handle break changes ([#90](https://github.com/plait-board/drawnix/pull/90))
- **active-toolbar:** add active toolbar ([7e737a2](https://github.com/plait-board/drawnix/commit/7e737a2))
- **active-toolbar:** support font color property ([4b2d964](https://github.com/plait-board/drawnix/commit/4b2d964))
- **app-toolbar:** support undo/redo operation ([50f8831](https://github.com/plait-board/drawnix/commit/50f8831))
- **app-toolbar:** add trash and duplicate in app-toolbar ([#28](https://github.com/plait-board/drawnix/pull/28))
- **color-picker:** support merge operations for update opacity #4 ([#45](https://github.com/plait-board/drawnix/pull/45), [#4](https://github.com/plait-board/drawnix/issues/4))
- **component:** improve the onXXXChange feature for drawnix component #79 ([#79](https://github.com/plait-board/drawnix/issues/79))
- **component:** add afterInit to expose board instance ([23d91dc](https://github.com/plait-board/drawnix/commit/23d91dc))
- **creation-toolbar:** support long-press triggers drag selection an… ([#78](https://github.com/plait-board/drawnix/pull/78))
- **draw:** bump plait into 0.75.0-next.0 and support fine-grained selection ([#69](https://github.com/plait-board/drawnix/pull/69))
- **draw-toolbar:** add draw toolbar ([#9](https://github.com/plait-board/drawnix/pull/9))
- **draw-toolbar:** add shape and arrow panel for draw-toolbar #10 ([#12](https://github.com/plait-board/drawnix/pull/12), [#10](https://github.com/plait-board/drawnix/issues/10))
- **drawnix:** init drawnix package ([397d865](https://github.com/plait-board/drawnix/commit/397d865))
- **drawnix-board:** initialize drawnix board ([117e5a8](https://github.com/plait-board/drawnix/commit/117e5a8))
- **fill:** split fill color and fill opacity setting ([#53](https://github.com/plait-board/drawnix/pull/53))
- **flowchart:** add terminal shape element ([#80](https://github.com/plait-board/drawnix/pull/80))
- **freehand:** initialize freehand #2 ([#2](https://github.com/plait-board/drawnix/issues/2))
- **freehand:** apply gaussianSmooth to freehand curve ([#47](https://github.com/plait-board/drawnix/pull/47))
- **freehand:** update stroke width to 2 and optimize freehand end points ([#50](https://github.com/plait-board/drawnix/pull/50))
- **freehand:** improve freehand experience ([#51](https://github.com/plait-board/drawnix/pull/51))
- **freehand:** add FreehandSmoother to optimize freehand curve ([#62](https://github.com/plait-board/drawnix/pull/62))
- **freehand:** optimize freehand curve by stylus features ([#63](https://github.com/plait-board/drawnix/pull/63))
- **freehand:** freehand support theme ([b7c7965](https://github.com/plait-board/drawnix/commit/b7c7965))
- **freehand:** support closed freehand and add popup for freehand ([#68](https://github.com/plait-board/drawnix/pull/68))
- **freehand:** bump plait into 0.75.0-next.9 and resolve freehand unexpected resize-handle after moving freehand elements ([#84](https://github.com/plait-board/drawnix/pull/84))
- **hotkey:** support export png hotkey ([#30](https://github.com/plait-board/drawnix/pull/30))
- **image:** support free image element and support insert image at m… ([#95](https://github.com/plait-board/drawnix/pull/95))
- **image:** should hide popup toolbar when selected element include image ([#96](https://github.com/plait-board/drawnix/pull/96))
- **menu:** support export to json file ([d0d6ca5](https://github.com/plait-board/drawnix/commit/d0d6ca5))
- **menu:** support load file action ([758aa6d](https://github.com/plait-board/drawnix/commit/758aa6d))
- **mobile:** adapt mobile device ([7c0742f](https://github.com/plait-board/drawnix/commit/7c0742f))
- **pencil-mode:** add pencil mode and add drawnix context ([#76](https://github.com/plait-board/drawnix/pull/76))
- **pinch-zoom:** support pinch zoom for touch device ([#60](https://github.com/plait-board/drawnix/pull/60))
- **pinch-zoom:** improve pinch zoom functionality and support hand moving ([#75](https://github.com/plait-board/drawnix/pull/75))
- **popover:** add reusable popover and replace radix popover ([d30388a](https://github.com/plait-board/drawnix/commit/d30388a))
- **popup:** display icon when color is complete opacity ([#42](https://github.com/plait-board/drawnix/pull/42))
- **popup-toolbar:** support set branch color remove color property when select transparent #17 ([#17](https://github.com/plait-board/drawnix/issues/17))
- **popup-toolbar:** bump plait into 0.71.0 and mind node link stroke and node stroke support dashed/dotted style #22 ([#22](https://github.com/plait-board/drawnix/issues/22))
- **property:** support stroke style setting ([463c92a](https://github.com/plait-board/drawnix/commit/463c92a))
- **size-slider:** improve size-slider component ([780be9d](https://github.com/plait-board/drawnix/commit/780be9d))
- **text:** support soft break ([#39](https://github.com/plait-board/drawnix/pull/39))
- **text:** support update text from outside ([#58](https://github.com/plait-board/drawnix/pull/58))
- **theme-toolbar:** add theme selection toolbar for customizable themes ([dca0e33](https://github.com/plait-board/drawnix/commit/dca0e33))
- **toolbar:** support zoom toolbar ([76ef5d9](https://github.com/plait-board/drawnix/commit/76ef5d9))
- **web:** seo ([84cde4b](https://github.com/plait-board/drawnix/commit/84cde4b))
- **web:** add cloud.umami.is to track views ([#64](https://github.com/plait-board/drawnix/pull/64))
- **web:** modify initialize-data for adding freehand data ([#65](https://github.com/plait-board/drawnix/pull/65))
- **web:** add debug console ([#83](https://github.com/plait-board/drawnix/pull/83))
- **wrapper:** add wrapper component and context hook ([#6](https://github.com/plait-board/drawnix/pull/6))
- **zoom-toolbar:** support zoom menu ([cc6a6b8](https://github.com/plait-board/drawnix/commit/cc6a6b8))

### 🩹 Fixes

- remove theme-toolbar font-weight style ([#67](https://github.com/plait-board/drawnix/pull/67))
- **arrow-line:** optimize the popup toolbar position when selected element is arrow line ([#70](https://github.com/plait-board/drawnix/pull/70))
- **board:** resolve mobile scrolling issue when resize or moving ([8fdca8e](https://github.com/plait-board/drawnix/commit/8fdca8e))
- **board:** bump plait into 0.69.1 deselect when text editing end refactor popup toolbar placement ([aef6d23](https://github.com/plait-board/drawnix/commit/aef6d23))
- **board:** use updateViewBox to fix board wobbles when dragging or resizing ([#94](https://github.com/plait-board/drawnix/pull/94))
- **color-picker:** support display 0 opacity ([#48](https://github.com/plait-board/drawnix/pull/48))
- **creation-toolbar:** use pointerUp set basic pointer cause onChange do not fire on mobile bind pointermove/pointerup to viewportContainerRef to implement dnd on mobile #20 ([#20](https://github.com/plait-board/drawnix/issues/20))
- **creation-toolbar:** move out toolbar from board to avoid fired pointer down event when operating ([ddb6092](https://github.com/plait-board/drawnix/commit/ddb6092))
- **font-color:** fix color can not be assigned when current color is empty ([#55](https://github.com/plait-board/drawnix/pull/55))
- **freehand:** fix freehand creation issue(caused by throttleRAF) ([#40](https://github.com/plait-board/drawnix/pull/40))
- **mind:** remove branchColor property setting ([#46](https://github.com/plait-board/drawnix/pull/46))
- **property:** prevent set fill color opacity when color is none ([#56](https://github.com/plait-board/drawnix/pull/56))
- **react-board:** resolve text should not display in safari ([19fc20f](https://github.com/plait-board/drawnix/commit/19fc20f))
- **size-slider:** correct size slider click handle can not fire ([#57](https://github.com/plait-board/drawnix/pull/57))
- **text:** fix composition input and abc input trembly issue ([#15](https://github.com/plait-board/drawnix/pull/15))
- **text:** resolve with-text build error ([#41](https://github.com/plait-board/drawnix/pull/41))
- **text:** fix text can not editing ([#52](https://github.com/plait-board/drawnix/pull/52))
- **use-board-event:** fix board event timing ([0d4a8f1](https://github.com/plait-board/drawnix/commit/0d4a8f1))

### ❤️  Thank You

- pubuzhixing8 @pubuzhixing8
