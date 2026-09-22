# 第七轮全仓库代码评审报告（2026-09-23）

- **方法**：code-review-skill 五维度清单（架构/性能/安全/质量反模式/常见 bug），8 个分区只读深评，
  两两并行：① toolbar/menu/popup/popover/multi-selection/view-navigation；② shared/ 与面板类小组件；
  ③ 小组件目录组（minimap/winbox/character/audio-node/unified-color-picker 等 27 目录）；
  ④ apps/web/src 全量（含 sw/index.ts 6947 行全文）；⑤ drawnix services/data/engine/mcp/constants；
  ⑥ supabase/migrations/scripts 增量；⑦ hooks/contexts/plugins/utils/tools/transforms 增量；
  ⑧ packages/utils + react-board + react-text + web-e2e。
- **与第五/六轮关系**：本轮发现基于第六轮批次 1/2 之后的代码（dcc06a02、37b9587c，经逐 diff 复核为
  忠实等价变换、无回归）。上两轮已登记项一律不重复，仅在「重叠修正」节勘误。
- **标注**：B = 行为保持（本轮修复或可修）；C = 修复必然改变对外行为，待用户拍板。
- **处置汇总**：批次 1 修复 10 条（P0/P1 安全与正确性）；批次 2 修复 17 条（组件层守卫/清理）；
  批次 3 修复 16 条（错误路径加固 + E2E 断言收紧）；暂缓/待确认见后两节。

## 一、P0

- [P0] packages/drawnix/src/components/popup/link-popup/link-popup.tsx:188-195 — `<a href={url}>`
  直接渲染画布链接元素 url 未过 `sanitizeLinkUrl`（utils/link-url-sanitize.ts 已有，MarkdownReadonly/
  TaskItem/KBNoteEditor 均已接，画布链接管线漏接）；url 随画板 JSON 经 loadFromJSON 导入/云同步流转，
  可携带 `javascript:` payload，点击即应用 origin 下执行脚本 — href 改 `sanitizeLinkUrl(url) ?? undefined`，
  正常 http(s) 链接零变化 — (B，**批次 1 已修**)

## 二、P1

- [P1] packages/drawnix/src/components/canvas-search/canvas-search.tsx:75,77 — 带 g 标志正则跨元素
  复用 `.test()`，lastIndex 残留致连续同名文本「隔一漏一」— 去 g 标志 — (B，**批次 1 已修**)
- [P1] packages/drawnix/src/components/shared/workflow/record-storage.ts:32-107 — 全部写操作为
  「读全量→改→写全量」无串行化，useWorkflowTaskSync 四工作流并发回填互相覆盖丢记录 — 按 storageKey
  promise 链互斥 — (B，**批次 1 已修**)
- [P1] packages/drawnix/src/services/prompt-storage-service.ts:560-580,986-1006,1092-1112 — 云端合并
  三兄弟不查 `deletedPromptContentsCache` 墓碑（对照 addPromptHistory:487 有查），用户删除的提示词每轮
  同步被云端旧副本复活；且 types.ts:14 `prompt_deleted` 墓碑类型全仓无生产者无消费者 — 三处 merge 先过
  isContentDeleted — (B 本地过滤，**批次 1 已修**；跨设备墓碑接线见待确认 4)
- [P1] packages/drawnix/src/hooks/useChatHandler.ts:138-186 — 发送锁 `isSendingRef` 置位后、try 之前
  三个未保护 await（addMessage/getSession/updateSession），任一 IDB 失败锁永不复位，聊天假死到刷新 —
  前置段纳入 try/finally — (B，**批次 1 已修**)
- [P1] packages/drawnix/src/services/model-adapters/kling-adapter.ts:543-578 — 轮询查询裸读
  `status.data.task_status`（提交处 ：532-537 已有 data 守卫，修 A 漏 B），网关 200+错误体即 TypeError —
  查询补守卫 — (B 守卫，**批次 1 已修**；瞬时错误退避重试属行为变化，见待确认 5)
- [P1] packages/drawnix/src/components/toolbar/app-toolbar/app-menu-items.tsx:353-391,448-452 —
  「清除失效链接」单次 HEAD `response.ok` 判生死（404/405/500 即判无效）并直接 removeNode、无确认；
  瞬时断网/SW 未接管时 `__aitu_cache__` 虚拟路径均被误删，数据丢失路径 — (C 待确认 6：双探+清单确认
  改变交互)
- [P1] packages/drawnix/src/services/backup-restore/environment-backup-service.ts:219-231 — replace
  模式先清空七域数据再顺序恢复，无事务无快照，中途失败环境已空 — (C，与已登记 backup-import-service
  非事务同批拍板)
- [P1] supabase/migrations/user_sync_media.sql:83-126 ↔ services/supabase-sync/media-sync.ts:246 —
  yue-sync 桶 RLS 仍是「JWT 邮箱 @ 前缀」口径，前端上传路径 oa_account 优先，oa≠邮箱前缀的用户云同步
  恒被 RLS 拒绝（huabu 已修 v2、yue-sync 漏网）— (C 待确认 7：需对生产库补 v2 迁移)
- [P1] scripts/jzxz-home-crawler.py:187-205,654,735 — glb_attempts「连续 3 次放弃」永不生效：
  or 过滤把在途失败行排除在返回外，skip_ids 恒 0，每轮重跑计数清零，无 glb 商品无限重采 — (C 待确认 8：
  运维脚本行为修复)

## 三、P2（本轮已修，B）

### 守卫/崩溃预防（批次 1/2）
- [P2] mcp/tools/shared/insert-utils.ts:273-274,425-426 — `getViewportOrigination(board)!` 非空断言
  （F27 同族漏网×2）— `?.`+原点回退（**批次 1 已修**）
- [P2] services/workflow-engine/engine.ts:41,313,408,442 — onTaskCreated 内 saveWorkflow 悬浮无 catch；
  stepTimeout 声明后从未读取（真超时接线属 C）；:313 saveWorkflow 在 try 外 — 补 .catch 留痕（**批次 1
  已修**；stepTimeout 见待确认 9）
- [P2] services/media-executor/fallback-adapter-routes.ts:315 — `void updateRemoteId()` 悬浮 — 补
  .catch（**批次 1 已修**）
- [P2] services/video-api-service.ts:214-274、services/audio-api-service.ts:918 — startLLMApiLog 后
  失败路径无 finalize，日志永久滞留 pending — try/catch 补 failLLMApiLog（**批次 1 已修**）
- [P2] components/toolbox-drawer/ToolboxDrawer.tsx:121-123 — getViewportOrigination 非空断言（F27 族）
  — 空值守卫（**批次 2 已修**）
- [P2] components/toolbar/popup-toolbar/link-button.tsx:36-38 — setTimeout 回调内二次 getLinkElement
  未判空即取 [0] — 补判空（**批次 2 已修**）
- [P2] utils/canvas-insertion-layout.ts:512 — maxBottomY 初值 0 应为 -Infinity，内容全在 y<0 时插入点
  错误（对照 selection-utils.ts:1414 正确写法）— 初值修正（**批次 2 已修**）
- [P2] utils/selection-utils.ts:676 — convertImageUrlToBase64 未传 timeoutMs（helper:487 支持），导出
  可无限挂起 — 补传（**批次 2 已修**）
- [P2] plugins/with-arrow-line-auto-complete-extend.ts:508-514 — `if (!generator) return` 在原始
  pointerMove 之前，整条默认链路被跳过（同文件 442-448 先调再 return 是正确写法）— 调序（**批次 2 已修**）
- [P2] components/character/CharacterTimeRangeSelector.tsx:263,295,334 — 拖拽 mouseup 用渲染闭包旧值
  seek，预览帧回跳 — 最新值写入 ref（**批次 2 已修**）
- [P2] plugins/with-gradient-fill.ts:20-23,286,363 — observer/boardRef/isFirstRender 模块级单例，画板
  重建后 MutationObserver 兜底失效 — (暂缓：触发面需实测画板切换路径，见待确认 10)

### 监听/定时器卫生（批次 2）
- [P2] components/shared/media-preview/MediaViewport.tsx:553-612 — 拖拽 document 监听仅在 mouseup/
  touchend 移除，拖拽中卸载即滞留（F54 同族）— cleanup ref + 卸载 effect（**批次 2 已修**）
- [P2] components/shared/media-preview/MediaViewport.tsx:469 — React 合成 onWheel 内 preventDefault
  空操作（根级 passive）— 原生监听 {passive:false}（**批次 2 已修**）
- [P2] components/toolbox-drawer/ToolboxDrawer.tsx:79-99 — 续办 effect 依赖缺 executeToolInsert/
  executeToolOpenWindow 且 setTimeout 无清理 — 补依赖+clearTimeout（**批次 2 已修**）
- [P2] components/minimap/Minimap.tsx:278-304 — 自动隐藏定时器只在展开变化时创建，交互不重置，每 3s
  隐藏再弹出闪烁（与注释意图不符）— 交互时重建定时器（**批次 2 已修**；10Hz 全量重绘见暂缓）
- [P2] components/canvas-search/canvas-search.tsx:68,150-156 — 200ms 防抖 setTimeout 无卸载清理 —
  clearTimeout（**批次 1 已修**）
- [P2] components/startup/DrawnixDeferredRuntime.tsx:286-531 — async setup+同步 cleanup 订阅模式，
  StrictMode 双挂载订阅泄漏、事件处理重复 — disposed 标志（**批次 2 已修**）
- [P2] packages/react-board/src/plugins/with-pinch-zoom-plugin.ts:155-175 — pointercancel 不清理
  pointerRecords，幽灵触点致后续单指进双指分支、viewport 乱跳 — cancel 同样 splice（**批次 2 已修**）

### 行为对齐/去重/配置修正（批次 2）
- [P2] components/popover/popover.tsx:220 — zIndex 硬编码写在 ...style 之后，调用方 zIndex 全被覆盖
  （creation-toolbar 嵌套分层 POPOVER+1、app-toolbar 4500 意图均失效）— 移除硬编码（**批次 2 已修**）
- [P2] components/toolbar/creation-toolbar.tsx:142-183 — BUTTONS 中 mind 配置整段重复两条，buttonMap
  后者静默覆盖 — 删除重复项（**批次 2 已修**）
- [P2] components/clean-confirm/clean-confirm.tsx:23-25 — setAppState 用渲染期快照展开非函数式更新，
  并发丢更新 — 函数式更新（**批次 2 已修**）
- [P2] components/unified-color-picker/UnifiedColorPicker.tsx:160-168 — 500ms 防抖 effect 对任何
  currentHex 变化都写「最近使用」，外部 value 同步即污染（与注释「只在用户操作后添加」不符）— 移除
  effect、仅在用户交互回调写入（**批次 2 已修**）
- [P2] components/toolbar/popup-toolbar/text-property-panel.tsx:161-246 — 面板保持打开时切换选区不重新
  反显（effect 依赖仅 [isOpen, board]）— 依赖补选区标识（**批次 2 已修**）
- [P2] plugins/freehand/freehand.generator.ts:338-412 vs 418-496 — 两个 ~80 行函数体逐行相同 — 删一
  保一（**批次 3 已修**）
- [P2] components/winbox/WinBoxWindow.tsx:521-525 — loadWinBox().then 无 catch，bundle 加载失败永久
  缓存 rejected promise，此后所有窗口静默打不开 — catch+失败重置允许重试（**批次 2 已修**）
- [P2] components/inspiration-board/InspirationBoard.tsx:39,105 — localStorage 裸写无 try/catch —
  包裹（**批次 3 已修**）

## 四、P2（本轮已修，错误路径加固——批次 3）

- [P2] components/dialog/ConfirmDialog.tsx:116-123,176 — handleConfirm 对 async onConfirm 无 catch，
  rejection 无人接 — catch+console.error（**已修**）
- [P2] components/command-palette/command-palette.tsx:156 — rAF 内 cmd.perform 无兜底，export-json
  失败即 unhandled rejection — try/catch+错误提示（**已修**）
- [P2] components/shared/media-preview/UnifiedMediaViewer.tsx:435-453 — handleDownload 尾段 smartDownload
  无兜底 — try/catch+失败提示（**已修**）
- [P2] components/media-library/MediaLibraryModal.tsx:195-197 — handleDownloadAsset 无 catch 且调用方
  先弹成功提示（F33/34 同文件漏网）— 补 catch+失败提示（**已修**）
- [P2] components/workzone-element/WorkZoneContent.tsx:294-302,445 — handleRetry try/finally 无 catch —
  补 catch+提示（**已修**）
- [P2] contexts/AudioPlaylistContext.tsx 调用点族 — MediaLibraryGrid.tsx:574,596,615,1172 与
  CanvasAudioPlayerPlaylist.tsx:294-355 fire-and-forget 调用无 catch — 逐点补（context 的 rethrow 被
  Grid.handleSubmitPlaylistDialog 依赖，不动）（**已修**）
- [P2] components/audio-node-element/CanvasAudioPlayer.tsx:405,424,555 — void playback.* 三处无人接 —
  包 try/catch 留痕（**已修**）
- [P2] tools/music-player/MusicPlayerTool.tsx:894-905 — 播放列表 Dialog onConfirm await 链无兜底 —
  包 try/catch（**已修**）
- [P2] components/toolbar/popup-toolbar/popup-toolbar.tsx:1560-1586,1276,1281,2312 — fitPPT 异步 IIFE、
  void resumePlayback/openMusicPlayerAndPlay 无兜底 — 补 catch（**已修**）
- [P2] apps/web/src/supabase/auth-form.tsx:70-99 — handleSubmit try/finally 无 catch — 补 catch+提示
  （**已修**；auth-context.tsx 属 WIP 在途未动）
- [P2] apps/web/src/crash-logger.ts:532-542 — SW 不可用环境下 queueCheckInterval 2s 永久空转 — 连续
  N 次未就绪即停表降级 localStorage（**已修**）
- [P2] apps/web/src/crash-logger.ts:965-982 — FPS<10 每 5s 无条件发快照挤掉 SW 端 50 条环形缓冲里的真
  crash 快照 — 加最小上报间隔（**已修**）

### E2E 断言收紧（批次 3，测试强度修复）
- [P2] apps/web-e2e/src/functional/media-library.spec.ts:33-37 — document.body.innerText 断言永真
  （弹窗背后工具栏常驻同名词）— 改 modal 作用域（**已修**）
- [P2] apps/web-e2e/src/functional/task-queue.spec.ts:22-28 — 同 body.innerText 弱断言族 — 改面板
  作用域（**已修**）
- [P2] apps/web-e2e/src/functional/chat-drawer.spec.ts:38-42 — 关闭按钮缺失时「收起」断言静默跳过仍绿
  — 缺失即显式 fail（**已修**）

## 五、待确认（需拍板，本轮不修）

1. **[P0 家族，上两轮维持] apiKey 四路扩散**（built-in-manifests URL 拼接 / with-tool iframe 广播 /
   settings-manager URL 参数与 CustomEvent / newapi-key oaAccount 接管）——需「按需下发+仅内存持有」
   统一设计。
2. **[P0] WIP 明文密码回写**（auth-context.tsx recordAccountPassword + user_profiles_add_password.sql）：
   维持前两轮「建议放弃」原判。
3. **[P1 资损族]** ai-proxy record_task_bill clone 必抛；reconcile-worker 补扣/退款静默吞错；
   supabase/migrations/generation_usage.sql:299-326 refund_task_bill UPDATE 不校验命中行数，与 ai-proxy
   safeRefund 并发双退——建议先补账务异常分支回归测试再统一修。
4. **[P1] 提示词删除跨设备传播**：需把 types.ts:14 `prompt_deleted` 真正接上 collector/apply 两侧（本地
   墓碑过滤本批已修）。
5. **[P1] kling 轮询瞬时错误退避重试**：与 audio/video 轮询实现对齐，改变「单次抖动即任务失败」行为。
6. **[P1] CleanInvalidLinks 双探+删除清单二次确认**：改变「一键清完」交互，UI 需过目。
7. **[P1] yue-sync RLS v2 迁移**（oa_account 口径，照 huabu v2 模式）：需对生产库执行迁移。
8. **[P1] jzxz-home-crawler glb_attempts 修复**：运维脚本，需确认后修改并在下次采集前验证。
9. **[P2] workflow-engine stepTimeout**：删除死配置（B）还是接线真超时（C）？
10. **[P2] with-gradient-fill 模块级单例失效**：需实测「画板切换不刷新」路径是否存在再定级与修法。
11. **[P2] generation-api AbortController 全链路无人消费**（image/video signal 未用、audio 被 adapter
    丢弃）：取消/超时真正中断轮询会改变可观察行为，与已登记「取消未透传 signal」一并拍板统一方案。
12. **[P2] iframe sandbox allow-same-origin 双实例**（tool.generator.ts:624 + ToolWinBoxManager.tsx:423）：
    需回归验证第三方工具可用性。
13. **[P2] creation-toolbar ↔ quick-creation-toolbar 批量插入 dimensions 漂移**：需确认哪侧是预期
    （quick 侧有注释与排位参数，倾向其为预期）。
14. **[P2] audio-api-service lyrics 误判条件**：需对照真实 suno 报文确认是否存在顶层 title 干扰。
15. **[P2] video-frame-cache 两处等待无超时**：挂起改失败需定超时阈值。
16. **[P2] fill-panel ≤10MB base64 直接进画板 JSON**：base64 随数据走 vs 缓存 URL，与已登记 base64
    家族统一口径。
17. **[P2] dev-monitor bucketUsage 全量分页聚合**：确定性劣化曲线，建议定再评估阈值（如 objects>20 万）
    后改 SQL 聚合。
18. **[P2] ModelVendorBrand HappyHorse 外网 logo**：内网可达性未知，需确认或本地化资产+onError 回退。
19. **[P2] aes-gcm 非 secure context 降级可逆 Base64**：消费方是否知悉「非密文」语义，产品口径确认。
20. **[P2] E2E-IMG-14（fixme）空白画布无选中粘贴图片被静默忽略**：产品级 bug 待排入修复队列。
21. **[P2] repair-task-media.mjs**：failed 计入口径、部分缺失场景重复归档、fetch 无超时——运维脚本，
    修法方向需确认（按下标补齐 vs 哈希去重）。

## 六、暂缓（附理由）

- **SW 家族**（llm-api-logger IDB 连接泄漏=F2 同族漏网、CORS 双失败空响应被 completedImageRequests
  当成功缓存 30s、首图关键路径串行 await、hasCachedMediaResponse 全量 blob、bootstrap 缩略图 fetch 无
  超时、GENERATE_THUMBNAIL 无 catch）：与第六轮同判——sw/index.ts 近 7000 行无组件级测试，先补
  createBufferedMediaResponse Range 边界与缓存续期回归测试再动。
- **轮询族**（multi-selection-handles rAF 每帧双 stringify、ViewNavigation 100ms interval、usePencilCursor
  100ms、Minimap 展开期 10Hz 全量重绘、AIInputBar SelectionWatcher）：改事件订阅属结构性改造，随
  god-file/专项批一次收口。
- **文本/监控杂项**：text-property-panel 打开面板预载 27 个 Google Fonts（内网连败；惰性化需过目字体
  下拉）；asset-storage-service 全库扫描判重（需内存索引设计）；sw-capabilities 三份插入实现漂移
  （随专项收敛）；initializeMCP import 副作用与 inferAuthTypeFromRoute 恒 bearer（已登记死逻辑/家族）。
- **大文件复制家族**（creation-toolbar ↔ more-tools-button ~150 行、AIInputBar 工作流双份、video-analyzer
  ↔ mv-creator GeneratePage）：随 god-file 拆分专项。
- **运维脚本**（jzxz-home-crawler mime 错标/空 source_id 归并、crawl-templates.sh 硬编码管理员、
  cleanup-probe-tokens/reconcile-worker 硬编码用户名）：配置化留部署窗口。

## 七、WIP 在途登记（本轮只登记不修）

- official-library/official-library-service.ts:231 搜索词未清理 PostgREST or 保留字符（listHomeMaterials
  已做，修 A 漏 B 第三份）——随在途批落地。
- media-library/AssetItem.tsx:409-423 memo 比较器漏比较回调与 asset.url/thumbnail——同上。
- apps/web-e2e/src/fixtures/canvas-helpers.ts WIP selectCenterElement 重试前置点击在创建态工具下可能
  产生退化元素——请 WIP 作者确认是否先复位工具态。
- image-upload-consistency.spec.ts E2E-IMG-09/11/12/13 把「>25MB 无校验」固化为断言：将来补校验时需
  同步翻转。

## 八、重叠修正（对前两轮报告的勘误）

- 第六轮 P1「apps/web/src/main.tsx:610,651 SW 通道初始化无限重试」：逻辑实际位于 apps/web/src/app/
  bootstrap.tsx:610,651（main.tsx 现仅 85 行启动壳，报告路径未随拆分更新）。发现成立，维持原判。
- 第五轮 P1「reconcile-worker Storage PUT 新建必 404，修法改 POST+x-upsert」：仓库两处先例
  （jzxz-home-crawler.py:212、repair-task-media.mjs:219）证明网关行为是「PUT 缺 x-upsert 头时新路径
  404」——最小修法为补该头，无需改 POST。
- with-tool.ts:216 订阅泄漏：现读已有 cancelled 分支退订，疑似已在后续修复，建议复核销项。
- model-pricing-service.ts:956 void update() 形似浮动 promise，实际 saveToStorage 内部已 catch——不成立，
  销项。
- **PromptHistoryTool.tsx:485 置顶提示未按返回值分流——销项（建议修法有害）**：核实
  setPromptContentPinned 在「成功取消置顶」时同样返回 false（函数以 `return pinned` 结尾），
  按返回值分流提示会让每次成功取消置顶都误报失败；「未找到内容」与「成功取消置顶」在返回值上
  不可区分，修此条需改服务契约（属 C），现状维持。

## 九、整体印象（第七轮增量）

1. 经六轮修复，注入/XSS 维度本轮仅新增 1 处（link-popup 漏接既有消毒器，属管线覆盖缺口而非无消毒
   能力）；新增问题集中在「失败路径无人接」「守卫修 A 漏 B」「轮询/订阅生命周期」三个长尾家族。
2. 数据正确性两个新 P1（提示词删除复活、yue-sync RLS 口径）都在**云同步链路**——该链路是当前测试
   覆盖最薄的区域，建议下一专项优先补 collector/apply/merge 的行为测试。
3. 公共包（utils/react-board/react-text）质量显著高于 apps/drawnix 层，本轮仅 1 条新发现。
4. 三个「接了死线」同型（stepTimeout 未读、AbortController 无人消费、prompt_deleted 无生产者）提示：
   配置/类型声明与真实接线之间缺乏一致性检查，值得在 CI 加简单 lint 或约定。
