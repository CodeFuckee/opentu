# 全仓库代码评审报告（2026-09-20，第四轮）

- **范围**：apps/web（含 sw/ 全量逐行）、packages/drawnix（components 巨石组件逐行、services、
  utils/hooks/transforms/contexts/engine/mcp/plugins、公共包 react-board/react-text/utils）、
  supabase/functions(+migrations)、scripts、apps/web-e2e、CI/部署配置。
- **方法**：按 code-review-skill 的 typescript/react/security/common-bugs/quality 指南与
  cross-cutting（错误处理/并发/SQL 注入/N+1）清单，分 6 个分区并行评审；与既有三轮报告
  （docs/CODE_REVIEW_PENDING_ISSUES.md、docs/code-review-2026-09-18.md、
  docs/code-review-2026-09-19.md）逐条去重，已登记项只核实不重复上报。
- **标注**：B = 行为保持可修；C = 修复必然改变对外行为，只报告待确认。
  行号为评审时点实测。对全部 P0/P1 做了人工二次核实。

---

## 一、本轮已修复（行为保持，5 批，5 个提交）

### 批次1：apps/web SW 层（6d097bde）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F1 | apps/web/src/sw/index.ts:4441,4484 | 音频/视频 fetch 拦截分支缺 `method==='GET'` 守卫（图片分支 4566 已修并留注释），POST 上传到 .mp3/.mp4 结尾或 hash 含 'video' 的 URL 会被 handleAudio/VideoRequest 强制转 GET | 对照图片分支补 GET 守卫（仅修复已损坏的 POST 路径，GET 正常流不变） |
| F2 | sw/index.ts:5440,5491 | videoBlobCache（单条≤50MB）的清理函数只挂在图片路径的 cleanupStaleRequests 上，纯视频会话长会话内存缓存只增不减 | 两处写入后主动调 cleanupVideoBlobCache() |
| F3 | sw/index.ts:612-737 | 控制台日志 4 个 IDB 辅助函数 `return new Promise(...)` 未 await，事务级 rejection 逃过内部 catch 直达未设防调用方（:768 裸调用即 unhandled rejection） | 改 `await new Promise` 让既有 catch 真正兜底（错误路径留痕，成功路径不变） |
| F4 | sw/task-queue/storage.ts:349-354 | getDB 把 openDB() 的 Promise 永久缓存，一次 IndexedDB open 失败 → SW 存活期内全部任务持久化静默失败 | 失败时重置 dbPromise=null 允许重试 |
| F5 | sw/task-queue/utils/thumbnail-utils.ts:184-199,281-296 | 同一 cacheKey 连续三次 cache.put（Request 键经 Cache 规范化与字符串键同一条目），每缩略图多两次冗余写，注释与代码相悖 | 保留单次 put |
| F6 | apps/web/src/crash-logger.ts:644,685,1023 | 死变量 lastUsedMB、bodyHasContent | 删除 |

### 批次2：组件层资源清理与 React 反模式（d3850f7c）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F7 | components/ai-input-bar/AIInputBar.tsx:1040-1095（同族：ttd-dialog/ai-video-generation.tsx:255-300、ai-image-generation.tsx:197-230、batch-image-generation.tsx:506-526 前段） | initialGenerationType/initialSelectedModelConfig 等 11 个初始值每渲染重算（4 次 resolvePreferredModelSelection→localStorage+JSON.parse、resolveInvocationRoute→settings-manager 全量解析），5200 行组件每键击触发；消费点全部为 useState/useRef 初始值语义 | 整块 useMemo 惰性化（同 09-18 批次2 initialPreferences 先例，首渲染结果不变） |
| F8 | components/ttd-dialog/batch-image-generation.tsx:711 | 撤销历史每次 tasks 变化（每键击）对整表 `JSON.parse(JSON.stringify())` 深克隆，行内 images 为 base64 data URL，历史上限 50 条 → 单次批量导入后每键击深克隆可达数百 MB 字符串 | 行级浅拷贝共享嵌套引用（TaskRow 全字段更新均为整体替换、无原地突变，undo/redo 恢复另有深克隆），快照语义不变 |
| F9 | batch-image-generation.tsx:1787,2030 | getRowTasksInfo 每行 filter 全表 `includes` O(行×任务)、downloadSelectedImages 在 forEach 内 `find` O(行×taskId×任务) | Set 命中 / id→task Map（顺序与结果不变） |
| F10 | batch-image-generation.tsx:1485-1581,1310,1412,2362,2376 | executeBatchImport 由 onClick 裸消费且 FileReader promise onerror=reject → 任一文件读失败 unhandled rejection + 确认弹窗卡死；两处 FileReader 无 onerror 静默丢图；executeSubmit 两处 floating | try/catch/finally 兜底（失败清理弹窗）、补 onerror 留痕、补 .catch |
| F11 | settings-dialog/settings-dialog.tsx:347-364,2230 | matchesProviderModelQuery 与 model-discovery-utils 的 matchesModelQuery 逐字重复；「图片优先异步接口」开关持久化 floating promise | 删重复改导入；补 .catch 留痕 |
| F12 | ai-input-bar/ModelSelector.tsx:406-411 | TypeIcon 定义在组件体内，每渲染新组件类型致图标子树重挂 | 提升模块级 |
| F13 | ttd-dialog/shared/ResizableDivider.tsx:114-161 | 拖拽监听在 mousedown 里注册、仅 mouseup 移除，拖拽中卸载即泄漏；currentWidth 死变量（且公式明显写错）；mouseup 的 saveWidth 写入拖拽开始时的旧值 | 监听改 effect 注册/清理；删死变量与冗余旧值保存（最终持久化值由 isDragging 变化的既有 effect 以最新值写入，不变） |
| F14 | project-drawer/FramePanel.tsx:953-998 | setSnapshotUrls 两处在 state updater 内写 ref（P1-36 同族），并发渲染丢弃更新时 ref 与 state 分叉 → 快照循环据 ref 误跳过致预览缺图 | ref 改为权威镜像、updater 外同步写入，setSnapshotUrls 直接收对象 |
| F15 | project-drawer/FrameSlideshow.tsx:402-421,518-534,424-489 | 全屏重定位 300ms setTimeout 句柄未清理（卸载后把视口拉回播放帧）；键盘导航在 state updater 内调 goToFrame（StrictMode 双触发重放转场）；handleClose 与 fullscreenchange 处理器约 20 行逐行重复 | 句柄入 ref + cleanup；改 currentIndexRef 计算（goToFrame 自身 setCurrentIndex）；抽 restoreViewportAndPointer/finishClose（原执行顺序逐段保持） |
| F16 | comic-creator/ComicCreator.tsx:1030-1097 | 两处 setPdfAttachment updater 内执行 unifiedCacheService.deleteCache（副作用入 updater，StrictMode 双触发重复删除） | 副作用移出 updater |
| F17 | ai-input-bar/PromptHistoryPopover.tsx:76-95 | promptItems 每渲染重算（多次读 promptStorageService localStorage），随父组件每键击重渲染 | useMemo（renderVersion 纳入依赖，失效时机与原每渲染重算一致） |

### 批次3：utils/services 去重与错误路径（977098a7）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F18 | utils/image-splitter.ts:1789-1836 | getBottommostInsertionPoint 与 selection-utils getInsertionPointBelowBottommostElement（:1405-1452）同算法逐字级重复（09-18 登记"功能重复"的具体化） | 本地实现删除改委托，按本模块契约映射 Point/undefined→对象/{100,100} |
| F19 | utils/gemini-api/auth.ts:293-307 | 模块级自执行块与同文件 initializeSettings（:267-290）逐字重复（15 行两份，启动时双份执行） | 自执行块改委托 initializeSettings；随之死亡的 removeApiKeyFromUrl 删除 |
| F20 | plugins/with-frame.ts:64 ↔ components/project-drawer/FramePanel.tsx:228 ↔ utils/frame-insertion-utils.ts:30 | DEFAULT_FRAME_NAME_REGEXP 三份同义正则 | 提取到中立模块 types/frame.types.ts 三处导入（frame-insertion-utils 反向依赖 with-frame，不能放 with-frame） |
| F21 | services/media-executor/fallback-executor.ts:358,527,722 | 三处计时日志遗留死变量 `const t0 = performance.now()` | 删除 |
| F22 | services/supabase-sync/sync-engine.ts:187-189,227-229 | 冲突「保留本地」的 upsertRemote 失败仅 `!error` 才计数、整体仍 success；syncMedia `.catch(()=>{})` 全静默 | 均补 console.warn 留痕（计数/成功语义不变） |
| F23 | services/workflow-engine/engine.ts:116-148 | resumeWorkflow `has()` 检查→await getWorkflow→set+执行，check-then-act 窗口内两次并发 resume 各持一份副本重复执行同一步骤 | await 后复查 has()，过期恢复直接放弃（单调用路径不变） |
| F24 | contexts/SupabaseSyncContext.tsx:404 | applyRemoteEntities 返回的 failed 列表被解构丢弃，下载失败实体不可观测 | 补 console.warn 留痕（是否重试/影响基线推进属行为变更，见待确认） |

### 批次4：E2E 辅助（2a20f7ab）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F25 | apps/web-e2e/src/fixtures/cloud-sync-helpers.ts:507-509 | probeRemoteMediaObject 查询成功但 0 行（媒体未同步）返回 `rowFound: true`，语义反转误导诊断附件 | 改 rowFound: false（无断言依赖） |
| F26 | apps/web-e2e/src/utils/template-seed.ts:91-93 | 清理首步用 PostgREST 不支持的 `in.(select ...)` 子查询（需服务端 allowlist）注定 4xx 后走回退，首请求纯浪费且注释归因错误 | 直接走「列出 id→按 id 删」两步删除（与原回退路径一致） |

### 批次5：批量生成锁复位与持久化留痕（c700465f）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F27 | components/video-analyzer/pages/GeneratePage.tsx:1449 + mv-creator/pages/GeneratePage.tsx:1412 | `await ensureBatchId()` 位于 try 之外，updateRecord 一旦 reject，batchVideoRunningRef 永久 true，后续「全部→生成视频」点击被守卫静默吞掉（两文件复制传播） | 移入 try 并就地 catch+return，失败时外层 finally 复位批量锁（成功路径不变） |
| F28 | components/comic-creator/ComicCreator.tsx:1367,1374,1393,1418,1440,1569 | 6 处 `void persistPatch(...)` 浮动调用：落盘失败即 unhandled rejection（乐观更新仅内存生效、刷新丢编辑零感知） | 统一补 `.catch(persistWarn)` 留痕（根治丢编辑属行为变更，见待确认） |

---

## 二、新问题清单（未修复）

### P0（1 条，全部需产品/架构决策后修复）
- [P0][C] packages/drawnix/src/services/supabase-sync/sync-engine.ts:103-105（配合 merge.ts:123-128）— runSync 把「当前远程全量键集」当 knownRemoteKeys 传入 compareEntityDiff，循环遍历的 key 本就来自 remoteEntities，`knownRemoteKeys?.has(key)` 恒真，实际语义退化为「非首次同步时凡本地缺失的远程实体一律 toTombstoneRemotely」：设备 B 未见过、由设备 A 新建的画板/任务/会话被 B 直接打云端墓碑，A 下次同步即真删本地（多设备互删，数据丢失）；上轮下载失败的实体同样被墓碑化；merge.test.ts:87 与 sync-engine.test.ts:133 均以显式子集断言了该退化行为，未覆盖多设备场景 — 修法：持久化「上次同步时已知的远程键集」或引入本地墓碑记录，tombstone 判定改用真实已知键（需先验证单设备语义兼容，属行为变更，待确认）

### P1（待确认类）
- [P1][C] supabase/functions/reconcile-worker/core.ts:200-213,589 — 对账锁无看门狗：acquireLock 成功后若本轮被 edge-runtime 墙钟杀掉（workerTimeoutMs=15min，进程被杀 catch 不执行）或上游 fetch 挂起（fetchNewapiLogs/fetchWithRetry 均无超时），reconcile_state.running 恒为 true，后续每轮 skip_lock，资损救回静默停摆 — running 加最后更新时间、超阈值孤儿锁接管 + 上游 fetch 补 AbortSignal.timeout（锁语义变更，待确认）
- [P1][C] components/video-analyzer/pages/GeneratePage.tsx:1706-1778（同族：mv-creator/pages/GeneratePage.tsx:1667-1753）— 批量视频 while 循环 FAILED 可重试时 retryCount 无上限；轮询超时路径 taskId=null 后重建新任务且旧任务永不取消 → 持续故障时无限重建计费任务、批次永不结束 — 加 MAX_RETRY 封顶 + 重建前 cancelTask（计费语义变更，待确认）
- [P1][C] components/comic-creator/ComicCreator.tsx:865-875 — 页选择 effect 在 `next.size===0` 时无条件全选，与 clearPageSelection（:1476）冲突：清空选择后任意一次 record 更新（每键击触发）即静默重选全部页，用户随后生成按全量页计费；且该 effect 每次返回新 Set 多一轮渲染 — 仅记录首次载入/页集合删减时重填（选择语义变更，待确认）
- [P1][C] services/kb-image-service.ts:19-29,110-117 — 32 位 DJB2 全文哈希做知识库图片判重（saveImage 对 noteImagesStore 全表扫描逐条比对），碰撞即静默复用错误图片（kb-save-manager DJB2 的同族新实例）— 改 SHA-256 并按 hash 建索引；存量 DJB2 哈希数据兼容需决策（待确认）

### P2（待确认类）
- [P2][C] services/workflow-submission-service.ts:391-412,551-573 — resumeWorkflowWithFallback 首建 fallbackEngine 不带 `forceFallbackExecutor:true` 而 submit 路径带；引擎单例「谁先创建谁生效」，刷新恢复过后新工作流静默改走 SW 执行器路由，与文件头注释相悖 — 统一由单一工厂创建
- [P2][C] contexts/SupabaseSyncContext.tsx:320-370 — pushToRemote 自称「以本地为准(上传)」，但 lastSyncTime=0 落入首次同步分支，本地 updatedAt≤远程的实体进 toDownload 后被 stub 吞掉，按钮语义与实际不符 — 按动作语义强制全量上传
- [P2][C] components/settings-dialog/settings-dialog.tsx:1805-1825 — handleCancel 在 hasPendingChanges 时执行 persistDrafts(true)（保存并关闭），唯一关窗路径也走它：关窗即保存，函数名「取消」与行为相反 — 产品语义二选一
- [P2][C] components/comic-creator/ComicCreator.tsx:1663-2028 — 批量生成无卸载清理，关闭工具后循环继续跑并持续 setState/写库（video-analyzer GeneratePage 已有卸载 abort 正确先例）— 卸载 abort 属行为变更
- [P2][C] components/comic-creator/ComicCreator.tsx:1902-1944 — 批量生成中单页 generateOnePage 抛错中断整批，剩余页永久停留 queued/running，状态永远「生成中」 — 单页隔离+滞留页置 failed（失败路径语义变更）
- [P2][C] components/ai-input-bar/SkillDropdown.tsx:279-284 — isExternal 分支徽标文案复制自 isSystem 分支，外部 Skill 显示「系统」徽标 — 改「外部」（用户可见文案）
- [P2][C] components/project-drawer/LayerPanel.tsx:609 — 图层面板标题写「历史记录」（复制粘贴残留） — 改「图层」（用户可见文案）
- [P2][C] components/ttd-dialog/markdown-to-drawnix.tsx:167-190、mermaid-to-drawnix.tsx:70-90 — 异步 convert 无序号守卫，连续输入旧解析晚返回覆盖新结果 — 递增 token（竞态胜负语义变更）
- [P2][C] components/character/CharacterTimeRangeSelector.tsx:263,295,334 — 三处拖拽 mouseup 的 seekToTime 读 mousedown 时刻陈旧闭包 state，最终 seek 回拖拽前位置（注释与实现相反）— ref 镜像最新值（改变 seek 结果=bug 修复）
- [P2][C] components/ai-input-bar/AIInputBar.tsx:4316-4327 等 5 处 — toWorkflowMessageData(workflowControl.getWorkflow()!, …) 非空断言，工作流被 abort 时 TypeError 且 retry 路径不在 try 内 — 空值早退（防崩路径语义）
- [P2][C] services/task-queue-service.ts:2249-2266 — deleteTask 不 abort taskAbortControllers（cancelTask 有 abort），删除执行中任务后后台请求跑到自然结束 — 删除时同步 abort（中止语义）
- [P2][C] services/task-queue-service.ts:2184-2242 — cancel 后立即 retry 的竞态：旧执行体 catch 的 shouldSkipExecutionWriteback 判否，把刚重试的任务改写 FAILED(EXECUTION_ERROR)，重试静默丢失 — 代际标记判定过期
- [P2][C] services/supabase-sync/repository.ts:78-103 — fetchRemoteEntities 按 updated_at 升序 range/limit 偏移翻页，排序键非唯一可漏行/重行，漏行与 P0 墓碑误判叠加放大丢失 — 追加 entity_id 次级排序或 keyset 分页（查询语义变更）
- [P2][C] utils/settings-manager.ts:1291（同型 gemini-api/auth.ts:218）— URLSearchParams.get() 已解码再 decodeURIComponent 二次解码，值含字面 % 抛 URIError 被吞，URL 注入 settings/apiKey 静默失效 — 删二次解码（bug 修复改变损坏路径行为）
- [P2][C] utils/runtime-model-discovery.ts:82-88 — hashString 32 位 DJB2 做 baseUrl+apiKey 变更检测签名，碰撞即漏检配置变更 — 改 SHA-256（签名兼容性）
- [P2][C] utils/photo-wall-splitter.ts:360-373 — flood fill 环形队列容量 ceil(w*h/2) 小于总入队上界 w*h，超容量环形覆盖未处理项致连通域静默出错 — 容量改 w*h+1（溢出场景输出改变）
- [P2][C] utils/image-splitter.ts:2142-2150 — 每次拆图最多 25 张子图以 `split-image-<ts>-<i>` 写 Cache Storage 且不存元数据，素材库/配额清理链路扫不到，反复拆图存储只增不减 — 写入 source 元数据纳入统一清理（清理语义）
- [P2][C] components/project-drawer/LayerPanel.tsx:504-530 — 隐藏仅写 g.style.display 不落数据，元素重渲染即重置 display，UI 标「已隐藏」画面已可见 — 状态落数据由渲染层尊重（数据模型）
- [P2][C] components/project-drawer/FrameSlideshow.tsx:246-255 — 画笔设置注释称「从 board 初始化」但 visible=false 时 initSettings 恒 null，播放器笔色/线宽与画布不符 — visible 变 true 时同步（显示行为微变）
- [P2][C] components/project-drawer/ProjectDrawer.tsx:1253-1256,1309-1311 — 删除当前画板之后才调 onBeforeSwitch，此时 saveBoard 经 getCurrentBoard 恒 false（死保存），挂起的 400ms 防抖保存会对已删 id 落盘抛 unhandled rejection — 删除前 flush 或显式跳过（保存时序）
- [P2][C] components/gradient-editor/GradientEditor.tsx:571 — 渐变色标可增删，Popover 以 index 为 key，删中间色标后弹层挂错（index-key 同族）— stop 唯一 id（需要数据结构加 id）
- [P2][B] supabase/migrations/user_profiles.sql:73 — 基础迁移仍 grant insert/update/delete to anon,authenticated，DB 侧重跑本文件即静默撤销 user_roles_is_admin.sql:58 的收权加固 — 删基础迁移写授权或加顺序告警（已应用迁移的修改策略需决策）

### P2（暂缓类，理由附后）
- [P2][B] services/task-queue-service.ts:488-494 — 每次进度/状态更新 persistTask 从 IndexedDB 读回全量任务（含 base64 大字段）再整体回写，音频 onProgress 与模拟进度定时器每 2-5 秒触发，带大参考图任务反复读写数 MB — 暂缓：落盘节流/跳过大字段需性能基准验证（09-18 同类暂缓先例）
- [P2][B] sw/index.ts:6416-6458 — 图片缓存命中路径每次命中 cache.put 整个 blob + cache.delete 刷新时间戳，最热读路径双倍 Cache I/O — 暂缓：时间戳刷新阈值涉及缓存新鲜度语义
- [P2][B] sw/index.ts:6416-6458（调试面板）handleDebugGetCacheStats 串行全量扫描且只认 content-length — 暂缓：仅调试面板触发，低价值
- [P2][B] components/ai-input-bar/ModelDropdown.tsx:500-504 — window.__aituPendingProviderNavigationIntent 跨组件导航接力（__kbPendingNavigation 同族新成员）— 暂缓：与已登记 window 全局家族一并收敛为显式 context/事件
- [P2][B] components/music-analyzer/pages/LyricsPage.tsx:310、CreatePage.tsx:593、video-analyzer/pages/GeneratePage.tsx:640,760,1187 — `void updateRecord(...).then(...)` 链式浮动调用（.then 后无 catch，rejection 逃逸；F28 同族）— 暂缓：多行 .then 链逐处补 catch 留待专项
- [P2][B] components/project-drawer/FramePanel.tsx:2848-2997 — persistPPTTitleDraft 等对每页逐次 setFramePPTMeta，N 页 N 个 board 事务各触发一次 afterChange→整面板重渲染 — 暂缓：批量事务需验证 afterChange 触发语义
- [P2][B] components/video-analyzer/pages/GeneratePage.tsx:603（mv 同）— processedTaskIdsRef 只增不减 — 暂缓：清理时机涉及重生成语义
- [P2][B] components/project-drawer/LayerPanel.tsx:433-443 — 再一处覆写 board.afterChange+保存原引用，与 FramePanel 链式包裹时卸载顺序倒置 — 暂缓：需统一订阅模块专项（P1-37 同族）
- [P2][B] components/project-drawer/TtsSettingsPanel.tsx:258-266,336-401 — 滑杆每个 input 事件全量设置写+广播 — 暂缓：onChange 只 setState/松手提交涉及时序（performance-panel 同族暂缓）
- [P2][B] utils/llm-json-extractor.ts:258-273 — collectCandidates 对 6+ 份 source 逐 {/[] 位置平衡扫描，大体积分析 JSON 主线程可感卡顿 — 暂缓：整体 JSON.parse 快路径会改变「收集全部候选」契约，需先审计多候选消费方
- [P2][B] hooks/usePencilCursor.ts:150-161 — 画笔模式 100ms setInterval 轮询 zoom — 暂缓：轮询→订阅属机制更换（ViewNavigation/Minimap 同族）
- [P2][B] utils/video-frame-cache.ts:141-168 — seekAndCapture 无超时守卫（duration=NaN 部分浏览器不触发 seeked 即永挂）；extractFrameFromUrl:133 catch 静默 — 暂缓：与「补超时」家族（归档 fetch、export-service.ts:375 等）一并专项处理
- [P2][B] components/comic-creator/export-service.ts:375 — 导出拉图 fetch 无超时无 signal — 暂缓：同上，补超时家族专项
- [P2][B] supabase/functions/reconcile-worker/index.ts:28 — service role key 普通字符串等值比较非常量时间 — 暂缓：supabase 函数无本地测试门禁，随部署窗口专项
- [P2][C] supabase/functions/ai-proxy/core.ts:395-412 — 热路径每个转发请求串行 3 次 configs REST 读 — 暂缓：进程级缓存涉及时效拍板
- [P2][C] supabase/functions/dashboard-stats/core.ts:1280-1350 — /overview 约 13 次 REST 往返 — 暂缓：合并查询涉及时效
- [P2][B] supabase/functions/template-crawler/core.ts:552-565 — crawlStats 无 limit 全表拉到 JS 聚合，超 max-rows 静默封顶 — 暂缓：统计口径变更（dashboard-stats 同族）
- [P2][B] apps/web-e2e/src/config/e2e.config.ts:76,80 — 内网地址与 anon key 硬编码兜底（edge-function-smoke 同族新实例）— 暂缓：env 必填改造与 smoke 脚本同批
- [P2][B] apps/web-e2e/src/utils（sw 抽查）— apps/web/src/sw/index.ts 巨石拆分（P1-12）维持专项暂缓

---

## 三、待确认汇总（需拍板后另行处理）

1. **[P0] supabase-sync knownRemoteKeys 恒真 → 多设备互删**（见上，本轮最高优先级；修复需先做多设备场景验证）
2. [P1] reconcile-worker 对账锁孤儿看门狗（涉资损救回可用性）
3. [P1] 两份 GeneratePage 批量视频重试无上限+超时重建不计费旧任务（涉计费）
4. [P1] ComicCreator 页选择 effect 静默全选（涉计费）
5. [P1] kb-image-service DJB2 判重（涉存量数据兼容，P1-25 同族决策）
6. [P2] settings-dialog「取消」实为保存关闭、pushToRemote 语义、ComicCreator 卸载 abort/单页错误隔离、SkillDropdown/LayerPanel 文案、CharacterTimeRangeSelector seek、AIInputBar 非空断言防崩、deleteTask abort、cancel→retry 竞态、repository 翻页键、settings-manager 双重解码、runtime-model-discovery DJB2、photo-wall 队列容量、image-splitter Cache 无主条目、LayerPanel 隐藏落数据、FrameSlideshow 画笔设置时序、ProjectDrawer 删除前 flush、GradientEditor stop id、user_profiles.sql 基础迁移写授权——逐项拍板
7. 三轮已登记的存量待确认项（明文密码、配额 RPC revoke PUBLIC、reconcile 双退、同步失败推进基线、precise-erase 几何、copyBoard 空副本、scripts 退出码三件套等）维持原判

## 四、整体印象（第四轮增量）

1. 四轮累计整改后，全仓库的「常规雷区」（监听器/定时器成对清理、XSS 消毒、response.ok 检查、requestId 竞态守卫）已成惯例，本轮新问题集中在三类：**修 A 分支没同步修兄弟分支**（SW 音频/视频 GET 守卫、批量生成两份复制文件各自演化）、**「单测通过、集成语义走样」**（sync-engine knownRemoteKeys 接线恒真，纯函数有测试但生产接线绕过了它）、以及**初始化/持久化的每渲染放大**（initial* 家族、persistTask 全量读回）。
2. 唯一 P0 出在云同步的多设备墓碑判定，是四轮评审中第一个「纯函数正确、生产接线退化」的样本；建议先在测试环境构造双设备场景复现，再决定修法（knownRemoteKeys 持久化 vs 本地墓碑）。
3. 两个 GeneratePage（video-analyzer/mv-creator 共约 4338 行）与 ComicCreator 的批量生成循环是当前正确性风险最集中的区域（无上限重试、锁不复位、状态滞留），已登记的三条 P1 全部落在这里；先抽公共 hook 再修，一处修两处得。
