# 第六轮全仓库代码评审报告（2026-09-22）

- **方法**：code-review-skill 五维度清单（架构/性能/安全/质量反模式/常见 bug），6 个分区并行深评：
  ① supabase functions + migrations + scripts；② apps/web + packages/utils + react-board/react-text；
  ③ drawnix services/data/mcp/engine/constants；④ drawnix hooks/contexts/tools/plugins/utils；
  ⑤ drawnix components（创建类）；⑥ drawnix components（面板/编辑器类）。
- **与第五轮关系**：本轮发现基于第五轮 66 条修复之后的代码。上轮已登记的存量待确认项
  （reconcile 锁看门狗、settings-dialog「取消」实为保存、use_template 防刷、GradientEditor
  index-key、mv/video GeneratePage 修 A 漏 B、WIP 明文密码回写）**维持原判**，本文只标注重叠不重复展开。
- **标注**：B = 行为保持（已修或可修）；C = 修复必然改变对外行为，只报告待用户确认。
- **处置汇总**：批次 1 已修 14 条（去重等价变换，dcc06a02）；批次 2 已修 6 条（死代码/微修）；
  暂缓 17 条（附理由）；待确认 40+ 条（安全/资损类为主，需拍板）。

## 一、P0（全部属 [C]，待确认）

- [P0] supabase/functions/newapi-key/index.ts:77 — oaAccount 由调用者任意声明且不校验归属，
  「平台已存在用户」分支会用管理员接口重置该 oa 账号的 new-api 密码并铸造 unlimited_quota
  令牌——任何登录用户传他人 oaAccount 即可接管其 new-api 账号 — 修法：服务端从 JWT 对应
  user_profiles.oa_account 取值，拒绝与登录身份不符的 oaAccount (C)
- [P0] packages/drawnix/src/tools/built-in-manifests.tsx:100 — 第三方工具 URL 把 `${apiKey}`
  拼进 query 发给 vercel.ddaiai.com，Key 经 URL 泄露给第三方并被历史/referer/日志记录 (C)
- [P0] apps/web/src/supabase/auth-context.tsx:84-86 — recordAccountPassword 把明文登录密码
  upsert 进 user_profiles.password（**上轮已登记，建议直接放弃该 WIP 功能**；文件有未提交在途改动）(C)

## 二、P1

### 后端（①区）
- [P1] supabase/functions/ai-proxy/core.ts:561 — record_task_bill 重试对已 text() 消费的响应
  调 .clone() 必抛 TypeError，MJ/videos 提交响应（任务 id）丢失、预扣额度无据可退 —
  修法：首次消费前先 clone() 留底 (C)
- [P1] supabase/functions/reconcile-worker/core.ts:463-471 — 补扣 consume_image_quota 失败仅
  静默返回 null 仍置 completed；后续 patch 失败再退款即双重退额 (C)
- [P1] supabase/functions/reconcile-worker/core.ts:506-526 — refund_image_quota 失败被忽略仍写
  quota_refunded 标注，后续轮次跳过——退款静默永久丢失（与上轮 reconcile 资损族同源）(C)
- [P1] supabase/functions/sync-staff-profile/index.ts:74-84 — oaAccount 任意声明可冒充他人
  显示名并借 image_monthly_quota_{department} 换取高额度部门 (C)
- [P1] supabase/functions/check-email/core.ts:39 — 无鉴权/限速，service_role 翻页拉取
  50×1000 auth 用户本地匹配：邮箱枚举 + DoS 放大 (C)
- [P1] supabase/functions/newapi-key/core.ts:480,495,524 — new-api 平台密码明文存
  user_profiles.newapi_password (C)
- [P1] apps/web/src/sw/index.ts:5703-5716 — createBufferedMediaResponse 未把 Range end 钳制到
  mediaSize-1，头体不一致可致播放器中止拉流 (C)
- [P1] apps/web/src/sw/index.ts:6469-6539 — 图片缓存命中路径每次 responseClone.blob() 全量读入
  内存并 cache.put 重写仅为刷新访问时间戳：热路径双倍内存+写放大 (C)
- [P1] apps/web/src/main.tsx:610,651 — SW 通道初始化失败时 500ms setTimeout 无上限重试常驻 (C)
- [P1] packages/drawnix/src/utils/settings-manager.ts:1305-1315 — `?apiKey=` URL 参数明文
  Key 进浏览器历史与代理日志（与 P0 apiKey 泄露家族同批拍板）(C)
- [P1] packages/drawnix/src/plugins/with-tool.ts:69-77 — initTool 主动把 settings.apiKey
  postMessage 给每个第三方工具 iframe (C)
- [P1] packages/drawnix/src/utils/gemini-api/apiCalls.ts:1014-1015 — callVideoApiStreamRaw
  流解析无跨 chunk 行缓冲（另两处 callGoogleGenerateContentRaw:478、callApiStreamDirect:814
  已修，属「修 A 漏 B」第三份），JSON 行被分包截断即静默丢弃视频内容 (C)
- [P1] packages/drawnix/src/plugins/with-hotkey.ts:409 — 未匹配的无修饰键（F5/Tab/Home/End）
  被无条件 preventDefault 吞掉 (C)
- [P1] packages/drawnix/src/hooks/useInfinitePagination.ts:265-269 — 调用方传内联 fetcher 时
  effect 重触发形成无限串行请求循环 (C)
- [P1] packages/drawnix/src/hooks/useAutoInsertToCanvas.ts:563-579 — resolvePendingInsertContext
  在 try 外且 pendingMap 已清空，一旦抛异常任务永久滞留 insertedTaskIds 不再插入 (C)
- [P1] packages/drawnix/src/hooks/useTaskExecutor.ts:87 — `includes('cannot')` 把
  "Cannot read properties of undefined" 等运行时错误误判为 AI 拒绝生成 (C)
- [P1] packages/drawnix/src/utils/settings-manager.ts:1450 — 占位符正则把纯字母数字真实
  apiKey 当占位符静默忽略，用户输入"看起来没生效" (C)
- [P1] packages/drawnix/src/services/media-executor/task-storage-writer.ts:399-448 — importTasks
  putRequest onerror 未 preventDefault，单条失败回滚整批（注释承诺不成立）(C)
- [P1] packages/drawnix/src/services/task-queue-service.ts:2063-2086 — 每个 progress tick 都
  persistTask+invalidateCache，叠加每秒轮询失效形成 IDB 写放大 (C)
- [P1] packages/drawnix/src/transforms/precise-erase.ts:131-165 — getShapePolygon 仅支持椭圆
  其余退化外接矩形，而 boolean.ts:166-320 同名函数支持 diamond/triangle/star 等完整形状 (C)
- [P1] packages/drawnix/src/transforms/property.ts:433 vs services/ppt/ppt-export-service.ts:259 —
  写入 mark 'underlined'，PPT 导出只读 'underline'，下划线导出丢失（与上轮 mv/video
  修 A 漏 B 同族，需确认预期侧）(C)
- [P1] packages/drawnix/src/components/ttd-dialog/batch-image-generation.tsx:686-698 — tasks 含
  base64 参考图，每键击整表序列化写 IndexedDB，大表时每键击数百 MB structured clone (C)
- [P1] packages/drawnix/src/components/comic-creator/ComicCreator.tsx:2938-2942 — 页提示词每键击
  全量记录写 IndexedDB (C)
- [P1] packages/drawnix/src/components/knowledge-base/KBNoteEditor.tsx:110-115 — 切换笔记
  clearTimeout 直接丢弃未落盘的 500ms 防抖保存，编辑静默丢失 (C)
- [P1] packages/drawnix/src/components/project-drawer/FramePanel.tsx:1236-1283 — rAF 无限轮询+
  每帧 JSON.stringify(selection) 同步选中态，持续占用主线程（同文件 1197-1207 afterChange
  包装触发 4223 行组件全量重渲染）(C 暂缓，与 god file 拆分同批)
- [P1] packages/drawnix/src/components/knowledge-base/KnowledgeBaseContent.tsx:318-337 — 语义搜索
  无 requestId/abort 守卫，慢查询返回覆盖新结果 (C)
- [P1] packages/drawnix/src/components/media-library/MediaLibraryGrid.tsx:447-449,667 —
  localStorage.setItem 无 try/catch，隐私模式/配额满抛未捕获异常崩组件树 (C)
- [P1] packages/drawnix/src/components/settings-dialog/settings-dialog.tsx:361-369 — 统计 4 类
  路由但 UI 显示"{n}/3 已配置"，新建预设必然 4/3（需过目）(C)
- [P1] packages/drawnix/src/components/ai-input-bar/AIInputBar.tsx:683 — SelectionWatcher 500ms
  常驻轮询画布空态 (B 暂缓——改事件订阅属结构性改造)
- [P1] components 大文件复制家族：AIInputBar 工作流引擎双份（3963-4081 vs 4489-4604 约 300 行）、
  video-analyzer 与 mv-creator GeneratePage 约 70% 相同（2197/2169 行）(B 暂缓——单独立项重构)

### 已修（本批 1，等价变换）
- task-queue-service.ts 7 段模拟进度 setInterval 与 2 处歌词 markdown 组装（提取
  startSimulatedProgress/formatLyricsMarkdown）
- transforms/property.ts 17 个文本 mark 函数复制骨架（提取 forEachTextEditor）
- transforms/precise-erase.ts 3 个橡皮擦扫描函数（提取 getEraserPathBounds/forEachIntersectingElement）
- utils/gemini-api/apiCalls.ts 3 处上游错误解析+埋点+抛错块（提取 trackAndThrowResponseError）

## 三、P2（择要，完整清单按区域）

### 后端（①区）
- [P2] check-email/core.ts:117-120 500 回传 GoTrue 错误原文 (C)；task-monitor/core.ts:406-410
  透传 PostgREST 错误 (C)；dashboard-stats/core.ts:428-439 countCompleted 失败静默返 0 误导
  周报口径 (C)；check-register/index.ts:38-48 员工账号枚举 oracle 无限速（内部注册页需要，
  产品决策）(C)
- [P2] reconcile-worker/core.ts:200-213 任务锁无 stale 超时（**上轮已登记，维持**）；core.ts:23
  与 scripts/cleanup-probe-tokens.sh:3 硬编码用户名 chenkaidi（暂缓：配置化留部署窗口）
- [P2] supabase/migrations/storage_images_policies.sql:14-18 images 公开桶任意 authenticated
  任意路径 insert (C)；deploy/feedbackland/provision.sql:33-36 TO public INSERT 不限前缀 (C)
- [P2] scripts/upload-and-deploy.js:74 sshpass -p 密码进进程列表（upload-nginx-config.js:68/100 同）
  (B 暂缓：改 sshpass -e 涉部署链路，留部署窗口)；upload-and-deploy.js:87 StrictHostKeyChecking=no
  MITM 风险（同前暂缓）；test-runner.mjs:190-197 shell:true 手工引号拼接（暂缓：本地/CI 均在用，
  动它需专项验证）；jzxz-material-crawler.py:498 r 未绑定 NameError、:473 XPath f-string 引号、
  :288-293 mime 错标 png (均 C，本地运维工具)；cleanup-probe-tokens.sh:5-10 密码命令行可见（暂缓）；
  edge-function-smoke.mjs:23-25 硬编码 IP（暂缓）
- [P2] template-crawler/core.ts:407 每模板行单独 GET fetchExistingState N+1 (B 暂缓：改批量
  in 查询建议随下轮一起做)；ai-proxy/core.ts:34,721 CORS * 7 处——纯 Bearer 模型下不构成
  可利用漏洞（信息项）；ai-proxy/core.ts:449-458 ≤32MB 全量解码内存峰值 (B 暂缓)
- [P2] scripts/jzxz-material-crawler.py:310 与 562 merge_into_result 重复定义（**批次 2 已修**）
- **核实不成立**：dashboard-stats/dev-monitor 的 innerHTML 模板拼接逐处核对均经 esc() 实体转义，
  无存储型 XSS 注入点。

### Web 应用（②区）
- [P2] apps/web/src/sw/index.ts:1303-1307 logSWDebug 空壳+20 余调用点（**暂缓**：有意保留的
  日志骨架，删除属大 diff 零行为收益）；react-board wrapper.tsx:599-622 logViewportDebug/
  formatDebugPayload（**暂缓**：同上）
- [P2] sw-console-capture.ts:275 无限自重试 (C)；auth-context.tsx:190-214 effect 依赖整个 status
  对象重复 configure（**暂缓**：该文件有在途 WIP）；sw/index.ts:5734 每静态请求 readVersionState、
  :3070-3081 activate 30s 清理窗口（**暂缓**：SW 专项）；supabase-client.ts:10-16 静默回退
  硬编码 IP (C)；persistSession localStorage（项目已接受的内网明文 HTTP 风险，维持现状）；
  crash-logger.ts:1246,1268 Request 对象 method 丢失 (C)；ErrorBoundary.tsx:289-294 外网二维码
  内网裂图 (C 需过目)；use-plugin-event.tsx:114-137 paste unhandled rejection (C)；
  utils/workflow/parser.ts:222 healJson 补引号正则无字符串感知 (C)；settings-manager.ts:1536
  引用比较假触发、:1489 并发丢更新 (均 C)；utils/media/image.ts:249-285 二分压缩每轮重复解码
  (B 暂缓)；security/index.ts:51 >30 位字母数字误脱敏 (C)
- **核实不成立**：apps/web/src 与公共包全量 grep 无 innerHTML/dangerouslySetInnerHTML/eval 用法；
  utils/gemini-api/auth.ts:42 innerHTML 为纯静态模板；target="_blank" 各处均带 noopener/noreferrer。

### drawnix services/engine（③区）
- [P2] task-queue-service.ts 双份埋点载荷 (C)、取消未透传 signal (C)、存根任务驻留 (C)、
  restoreTasks 单事件 (C)、completedAt 无条件覆盖 (C)、音频 URL mime 错位 (C)；
  task-supabase-archive/service.ts warn 刷屏（暂缓：日志策略统一另定）；god file 拆分（暂缓：专项）
- [P2] unified-cache-service.ts:1826 checkDBExists 探测建库恒真 (C)、touch 非原子 (C)、
  cacheMediaFromBlob 双份内存 (C 待确认 SW 端类型限制)；sw-channel/client.ts:938 destroy 单例
  不同步 (C)、:1031 空负载吞掉 (C)；fallback-executor.ts:772 空 else 分支 videoId 无人轮询 (C)、
  :1285 resume 轮询不可取消 (C)、:78 inferAuthTypeFromRoute 恒 bearer（暂缓：死逻辑）、
  :1405 baseUrl 缺失静默回退第三方 api.tu-zi.com（**C 重点确认**）；task-storage-reader.ts 全表
  扫描未用 status 索引（暂缓：改索引需确认返回顺序契约）；ppt-export-service.ts:72 toPptColor
  四位 hex/具名色 (C)、:560 ensureBase64Image 无去重 (B 暂缓)；WorkflowEngine.ts:403 参数映射在
  try 外 (C)、:437 超时孤儿执行 (C)；data/blob.ts:14 吞异常 (C)、:72 FileReader 无 onerror (C)；
  data/image.ts:375 九参数膨胀（暂缓）、:527 下标定位选错 (C)；interfaces/video.ts:31
  Date.now() 生成 id 冲突 (C)；fallback-utils.ts:90 双套视频轮询并存（暂缓：需清点调用方）

### drawnix hooks/plugins（④区）
- [P2] settings-manager.ts:1574 CustomEvent detail 携带明文 Key (C 与 P0 家族同批)、:1239/:1388/:1625
  getSetting.call 伪造 this（**批次 2 已修**：提取 getSettingFromBag）；image-splitter.ts:254
  scoredConfigs 未按得分排序 (C)、:889 双重解码（暂缓：Worker 专项）、catch any（**批次 2 已修**）；
  useAutoInsertToCanvas.ts:1528 taskCreated 全量扫描（暂缓）、:1572 setTimeout 未清理 (C)；
  contexts AssetContext cleanup/渲染期赋值 (C)、ModelHealthContext value 未 memo（暂缓）、
  SupabaseSyncContext void applyRemoteEntities (C)；runtime-model-discovery.ts:1498 无超时/互斥 (C)；
  with-tool.ts:216 订阅泄漏 (C)；with-frame.ts:908 每帧 innerHTML 重建（暂缓）；apiCalls.ts:337
  normalizeGoogleImageResponse mime 缺省 video/mp4 (C 一行修)；drawnix.tsx:1622 __drawnixBoard
  全局（暂缓）、:851 选择变化全树重渲染（暂缓：专项）；useMediaCache.ts blobUrl 死代码
  （**批次 2 已修**）

### drawnix components（⑤⑥区）
- [P2] batch-image-generation.tsx:1575,1589 executeBatchImport 成功路径 endTrack 双调用
  （**批次 2 已修**）；:492 previewUrls render 期 Blob URL (C)；window 全局侧信道
  __copiedCells 等（暂缓：跨组件契约专项）；AIInputBar.tsx:4703 __executeWorkflowRetry 未清理 (C)、
  :386 import 即初始化副作用 (C)；popup-toolbar.tsx:2420 帧插入失败无提示 (C 需过目)、
  :273 memo 恒失效（暂缓微）；ChatDrawer.tsx:159 命名误导（放弃：不值得 diff）、:215 resize 重挂
  监听（暂缓）；undo/redo 深克隆（暂缓：与防抖批同议）；ttd-dialog/ai-video-generation.tsx.tmp
  死临时文件（**批次 2 已删**）；MermaidRenderer SMIL 纵深防御（**C 需同意引入 DOMPurify 依赖**，
  现有手写消毒器 fail-closed 是亮点，modern 浏览器已封 SMIL javascript:，降为纵深）
- [P2] settings-dialog.tsx:495 inferAuthTypeForProviderType 恒 bearer 死逻辑（暂缓）、:1160 监听器
  随按键重挂（暂缓）、:1786 关闭即保存（**上轮已登记维持**）、:2669 非响应式外部读（暂缓）；
  model-benchmark launchGuardRef 时序（暂缓）、:1486 每渲染 JSON.stringify（暂缓）；
  tool-element/tool.generator.ts:624 iframe sandbox allow-same-origin 对同源工具等于取消沙箱
  （**C 重点确认**：element.url 随画板数据流转不可信，但需回归验证工具可用性）；
  shared/ContextMenu.tsx:197 onSelect unhandled rejection (C)；TaskItem memo 比较器（暂缓）；
  KnowledgeBaseContent 拖拽死代码（暂缓）、localStorage 裸写 (C)；ProjectDrawer 递归节点重建/
  getFolderOptions（暂缓）、:1519 导入失败整页刷新 (C)；KBNoteEditor.tsx:431 faviconUrl 未消毒 (C)；
  CharacterTimeRangeSelector.tsx:124 seek 无超时 (C)
- **核实不成立**：⑤⑥区 6 处 target="_blank" 全部带 rel noreferrer/noopener；MermaidRenderer 的
  svgContent 经 sanitizeMermaidSvg（fail-closed）消毒后才进 innerHTML；Markdown 渲染输出 React
  节点并经 link-url-sanitize 白名单校验。XSS 面干净。

## 四、待确认汇总（需拍板，按建议优先级）

1. **[P0] newapi-key oaAccount 接管**（修法明确：服务端以 user_profiles.oa_account 为准）——安全影响最大
2. **[P0] apiKey 泄露家族**（built-in-manifests URL 拼接 + with-tool iframe 广播 + settings-manager
   URL 参数/CustomEvent detail 四路扩散）——需统一设计「按需下发+仅内存持有」
3. **[P0] WIP 明文密码回写**（上轮已建议放弃，等用户对在途分支定去留）
4. **[P1] 资损/账务失败路径**（ai-proxy clone 必抛、reconcile 补扣/退款静默吞错）——建议先补
   账务异常分支回归测试再修
5. **[P1] check-email 未鉴权全表扫描**（枚举+DoS）
6. **[P1]「修 A 漏 B」第三份**（callVideoApiStreamRaw lineBuffer，修法零设计空间，建议直接批准）
7. **[P2] 工具 iframe sandbox allow-same-origin**（需回归验证第三方工具可用性）
8. **[P2] baseUrl 缺失静默回退 api.tu-zi.com**（确认是否既定默认）
9. 其余错误路径加固类（onerror preventDefault、localStorage try/catch、unhandled rejection、
   防抖、竞态守卫等，见上文 C 标注）——批量确认后可按家族一次清掉

## 五、暂缓项理由汇总

- **SW 关键路径性能项**（readVersionState 每请求、缓存命中重写、activate 清理窗口、logSWDebug
  空壳）：sw/index.ts 近 7000 行无组件级测试，等价重构也建议先补 createBufferedMediaResponse
  Range 边界与缓存续期回归测试再动。
- **god file 拆分**（AIInputBar 5289 行、batch-image-generation 3930 行、FramePanel 4223 行、
  popup-toolbar 2866 行、task-queue-service 2592 行、settings-dialog 3202 行、GeneratePage×2）：
  单独立项，重构前先为 executeStep 引擎/persistPatch/FramePanel PPT 编排补行为测试。
- **死逻辑函数**（inferAuthTypeFromRoute/inferAuthTypeForProviderType、logSWDebug）：疑似有意
  保留的扩展点，删除收益低于 diff 风险。
- **scripts 部署链路加固**（sshpass/StrictHostKeyChecking/test-runner shell:true）：涉及部署
  窗口与 CI 基建，单独排期。
- **窗口/重渲染性能税**（SelectionWatcher 轮询、FramePanel rAF、每键击 IDB 写等已列 P1 的除外）：
  与 god file 拆分同批做。
- **日志级别、命名误导、微注释**：收益低于 diff 噪音。

## 六、整体印象（第六轮增量）

1. 五轮修复后存量问题继续呈长尾分布，本轮新增最有价值的集中在两条线：**凭据多路扩散**
   （apiKey 经 URL/iframe/事件/明文落库四路，占全部 P0 与多 P1）与**账务失败路径静默吞错**
   （补扣/退款/bill 记账失败无告警）。建议下一轮以「凭据下发清单」「资损路径对账」两个专项收口。
2. 「修 A 漏 B」家族仍在新增（SSE lineBuffer 第三份、underlined/underline、getShapePolygon
   双实现），复制粘贴仍是最大 bug 来源——本批 1 的 4 组去重即针对该家族的高发地。
3. 安全面整体健康：上轮线索的 innerHTML/target=_blank 本轮逐一核实均已有缓解（esc()/rel/
   fail-closed 消毒），未发现新的注入点；真正缺口在鉴权维度（newapi-key 归属、check-email
   匿名全表扫描）而非注入维度。
