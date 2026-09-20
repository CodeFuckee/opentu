# 全仓库代码评审报告（2026-09-21，第五轮）

- **范围**：apps/web（含 sw/ 全量逐行）、packages/drawnix（components 三分区、services、
  utils/hooks/contexts/plugins）、supabase/functions(+migrations)、scripts(+CI/部署)、
  apps/web-e2e、公共包 react-board/react-text/utils，共 9 个分区约 30 万行。
- **方法**：按 code-review-skill 的 typescript/react/python 指南与 cross-cutting
  （安全/错误处理/并发/N+1/SQL 注入/XSS）清单分区评审；与既有四轮报告
  （docs/CODE_REVIEW_PENDING_ISSUES.md、code-review-2026-09-18/19/20.md）逐条去重，
  已登记项只核实不重复上报；已知问题「家族」的新实例单独标注。
- **标注**：B = 行为保持可修；C = 修复必然改变对外行为，只报告待确认。
  行号为评审时点实测。

---

## 一、本轮已修复（行为保持，5 批）

### 批次1：apps/web SW 层（0c84b11d，流水线 #2735 全绿）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F1 | sw/index.ts:4542 | 字体 fetch 分支缺 `method==='GET'` 守卫（音频/视频/图片均已修，F1 同族漏网），非 GET 命中时被强制转 GET | 对照兄弟分支补守卫 |
| F2 | sw/index.ts openServiceWorkerDB | handleStaticRequest 每个静态请求新开 IDB 连接且从不关闭，热路径连接堆积 | 模块级缓存连接（失败重置可重试 + versionchange 关闭防阻塞升级） |
| F3 | sw/index.ts updateVersionState | 「读→改→写」跨两个事务非原子，install 预热与 COMMIT/FORCE_UPGRADE 消息并发互相覆盖 patch | 单 readwrite 事务内读改写（写失败回退为按旧值打补丁返回，语义不变） |
| F4 | sw/index.ts:3524 | debugLogs/consoleLogs 均 unshift（最新在前），`slice(-100)` 实发最旧 100 条，与注释相反 | `slice(0, 100)` |
| F5 | sw/index.ts:5703,5775,5845 | 三处 `cache.put` 悬浮，配额写失败即 unhandled rejection | 补 `.catch` 留痕 |
| F6 | sw/task-queue/llm-api-logger.ts:558,627 | complete/fail/updateMetadata 只在 50 条内存环形缓冲里找，长任务期间条目被淘汰后更新丢失、IndexedDB 永久 pending | 补 getLogByIdFromDB 读回补更新（applyLLMApiLogUpdate 统一入口，内存路径语义不变） |
| F7 | sw/cdn-fallback.ts:573-587 | `includes('404')`/`includes('Not Found')` 把含错误码常量的正常 JS/CSS/JSON 误判为 HTML 错误页，累计 CDN 降级冷却 | 仅按 `<!DOCTYPE`/`<html` 结构标记判定错误页 |
| F8 | app/app.tsx:502-516 | recoverVideoUrlsInElements 用 `.map()` 恒返回新数组，启动「有恢复才更新」守卫恒真，无可恢复项也多一轮全量 setValue | changed 标记位，无变更返回原数组引用 |

### 批次2：hooks/contexts/services 去重与留痕（b9530470）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F9 | [P1] contexts/WorkflowContext.tsx:106-120 | useWorkflowControl 每渲染返回新字面量，经 useWorkflowSubmission 传入 useTaskWorkflowSync effect deps → 每键击重订阅并清空事件缓冲，恢复窗口内任务终态事件永久丢失 | 返回值 useMemo 化（消费方拿到的函数引用不变） |
| F10 | hooks/useModelHealth.ts | 与 contexts/ModelHealthContext 逐段重复的整套轮询实现且全仓库零引用（死代码 205 行） | 删除文件 |
| F11 | utils/startup-prefetch.ts:21-25 | logStartupPrefetch 空操作（函数体无语句），8 个调用点每次构造 detail 对象 | 删函数及调用点 |
| F12 | contexts/SupabaseSyncContext.tsx:398,460 | `void kvStorageService.set(...)` 浮动（set 失败会 rethrow） | 补 `.catch` 留痕 |
| F13 | contexts/AudioPlaylistContext.tsx:30-47 | loadPlaylists try/finally 无 catch，初始化失败成 unhandled rejection | 补 catch 留痕 |
| F14 | hooks/useAllTracksPlaybackSources.ts:18,36 | `void refresh()` 无 catch；cacheRef 只增不减 | 补 catch；缓存上限 50（淘汰可重建） |
| F15 | utils/gemini-api/auth.ts:250 | 模块初始化 `geminiSettings.update(...)` 浮动 | 补 `.catch` |
| F16 | services/canvas-audio-playback-service.ts:548,1042,1123 | `void continueQueueAfterCurrentEnd()/resumePlayback()`，audio.play() 被拒即 unhandled rejection | 三处补 `.catch` 留痕 |
| F17 | services/model-benchmark-service.ts:534 | `void kvStorageService.set(...)` 浮动 | 补 `.catch` |
| F18 | services/workspace-service.ts:1005 | 防抖定时器 `void flushPendingCurrentBoardSave()`，saveBoard 失败即 rejection | 补 `.catch` 留痕 |
| F19 | services/feedbackland-sso.ts:112 | getToken().then 链尾无 catch，会话过期即 rejection | 补 `.catch` 留痕（不向 iframe 回包，与既有失败路径一致） |
| F20 | services/toolbar-config-service.ts:113 | initializeAsync().then 无 catch | 补 `.catch` 保留默认配置 |
| — | ai-input-bar/SizeDropdown.tsx + scss | 死文件（零引用、未进 barrel） | 删除（随本批入库） |

### 批次3：components 竞态守卫/资源清理/错误留痕（2ea29bd6）
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F21 | [P1] ttd-dialog/batch-image-generation.tsx:506-526 | F7（第四轮）惰性化在同族文件漏网：resolveInvocationRoute+findMatchingSelectableModel 每渲染裸执行（仅被 useState 初始值消费），3900 行组件每键击全量解析 settings-manager | useMemo 惰性化（首渲染结果不变） |
| F22 | ttd-dialog.tsx:177,197 | `void updateActiveInvocationRouteModel(...)` 无 catch | 补 `.catch` 留痕 |
| F23 | AIInputBar.tsx:386-395 | 模块级 `mcpInitialized` 死守卫（标记无人再读） | 删守卫直接执行 |
| F24 | AIInputBar.tsx SelectionWatcher | async handleSelectionChange 无序号守卫，慢返回的旧选区结果覆盖新选区（requestId 竞态家族） | 递增 token，过期回调丢弃 |
| F25 | AIInputBar.tsx:824-827 | usePromptHistory 解构出 history/deletePromptHistory 从未使用，state 变化连带 5200 行组件无效重渲染 | 只解构 addHistory |
| F26 | SkillDropdown.tsx:105-116 | effect 依赖缺 externalSkills/userSkills，打开瞬间按空/陈旧列表算高亮 | 依赖补全 |
| F27 | markdown/mermaid-to-drawnix.tsx | `getViewportOrigination(board)!` 非空断言，undefined 时 TypeError | `?.` + `?? 0` 回退防崩 |
| F28 | markdown-to-drawnix.tsx:150 | 加载失败日志写「Failed to load mermaid library」（复制残留，仅日志） | 改 markdown |
| F29 | video-analyzer/AnalyzePage.tsx:438,476 | 两处 setPdfAttachment updater 内执行 deleteCache（F16 同族漏网） | 副作用移出 updater |
| F30 | 两份 GeneratePage（video:505,682；mv:425,648） | `void applyRecordPatch/applyProductInfoPatch` 无 catch（含每次切模型触发的持久化 effect） | 补 `.catch` 留痕 |
| F31 | mv-creator/pages/ScriptPage.tsx:310 | `void syncMVRewriteTask().then()` 链无 catch（video 兄弟已有） | 补 catch + setError（对齐兄弟文案） |
| F32 | ComicCreator.tsx:2128-2161 | handleToggleStarRecord/handleDeleteRecord 内 await 无兜底，失败即 unhandled rejection 且用户无感知 | try/catch + MessagePlugin |
| F33 | media-library/MediaLibraryModal.tsx:133,165 | handleUseAsset/handleBatchUse await onSelect 仅 try/finally，上游持久化失败即 rejection、弹窗卡住 | 补 catch + 提示 |
| F34 | media-library/MediaLibraryGrid.tsx | 动态 import ×2 无 catch；handleAssetDownload/handleBatchDeleteClick/handleDeletePlaylist/handleSubmitPlaylistDialog 内部 await 链无兜底 | 逐个补 catch/提示 |
| F35 | media-library/MediaLibraryInspector.tsx:197 | await onSelectMultiple 无 catch | 补 catch + 提示 |
| F36 | music CreatePage/GeneratePage/LyricsPage + mv AnalyzePage | 四份防抖保存定时器 async 回调 `await updateRecord` 无兜底（rejection 无人接住） | 回调包 try/catch 留痕 |
| F37 | music-analyzer/pages/CreatePage.tsx:188-199 | audioPreviewUrl 在 useMemo 内 revoke/createObjectURL（渲染期副作用，并发渲染丢弃时悬空/泄漏） | 改 useEffect + state |
| F38 | mv GeneratePage handleShotGenerateVideo | async 但体内无 await，buildVideoPrompt 抛错进被 onClick 丢弃的 promise | 去掉 async |
| F39 | mv GeneratePage handleInsertScriptToCanvas | 无 `!board` 守卫（video 兄弟有），无画板时把模块级 boardRef 置空 | 补同款守卫 |
| F40 | project-drawer/FramePanel.tsx:3271 | persistOutlineDrafts 位于 try 之外，抛错经 onClick 的 void 调用成 unhandled rejection | 包 try/catch 留痕 |
| F41 | task-queue/DialogTaskList.tsx:162 | `filtered.sort(...)` 原地突变：无过滤条件时直接排序 hook state 数组（render 期间突变） | `[...filtered].sort` |
| F42 | task-queue/TaskQueuePanel.tsx:733 | handleRegenerate 每渲染新建，TaskItem memo 比较器 `onRegenerate` 恒 false，memo 形同虚设 | useCallback |
| F43 | task-queue/TaskItem.tsx:383-398 | 尺寸探测 `new Image()` 无 cancelled 守卫，URL 切换后旧 onload 覆盖 | cancelled 标志 |
| F44 | image-editor/ImageEditorCore.tsx:327-344 | 图片快速切换时旧 Image.onload 晚返回把陈旧 img 写回 imageRef，之后可能导出旧图 | cancelled 标志 |
| F45 | chat-drawer/ChatDrawer.tsx:722-726 | handleToggle 在 updater 内调 onOpenChange（StrictMode 双触发） | 副作用移出 updater |
| F46 | ChatDrawer.tsx:1355-1367 | thinking 防抖 setTimeout 在 updater 内创建，且 ref 卸载无清理 | payload 记录、updater 外调度 + 卸载清理 |
| F47 | ChatDrawer.tsx:1290-1308 | handleAppendAgentLog 在 updater 内持久化（P1-36 同族） | 同 F46 模式 |
| F48 | ChatDrawer.tsx:471,496 | pending message 两处 100ms setTimeout 无清理，卸载后仍触发发送 | effect cleanup |
| F49 | KnowledgeBaseContent.tsx:74-78 | useState 实参每渲染执行 loadSortPreference()（读 localStorage） | 惰性初始化 |
| F50 | KnowledgeBaseContent.tsx:851-864 | handleFileSelected 无兜底，单文件导入失败即 rejection、后续文件中止且无提示 | 逐文件 try/catch + 失败计数提示 |
| F51 | KBKnowledgeExtraction.tsx:188,373-428 | resolveInvocationRoute 每渲染执行；流式请求卸载/切笔记不 abort | useMemo；ref 镜像 + 卸载 abort |
| F52 | toolbar/app-menu-items.tsx:85-91 | loadFromJSON().then 无 catch | 补 catch + 提示 |
| F53 | audio-node-element/CanvasAudioPlayer.tsx:499 | 动态 import 无 catch | 补 `.catch` |
| F54 | gradient-editor/GradientEditor.tsx:290-324 | 拖拽监听 mousedown 注册、仅 mouseup 移除，拖拽中卸载泄漏；重置 setTimeout 未清理 | cleanup ref + 卸载 effect |

### 批次4：E2E 安全项 + 公共包 + scripts
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F55 | apps/web-e2e/src/functional/template-gallery.spec.ts:301 | 剪贴板组 afterAll 无条件 cleanup，缺 service key 时种子 skip 但清理抛错整套件报红（首组有 seedFailed 守卫） | 对齐补守卫 |
| F56 | apps/web-e2e/src/fixtures/cloud-sync-helpers.ts:343 | fetchBoardRows 无分页（REST 默认 1000 行静默截断），账号 board 超限后校验漏报；!res.ok 静默返回 [] | range 分页拉全 + 失败 warn |
| F57 | cloud-sync-helpers.ts:214 | clickSyncAction 用 isVisible() 立即检查确认弹窗，慢一帧即跳过、以 30s toBeEnabled 超时呈现误导失败 | waitFor visible 2s |
| F58 | functional/cloud-sync-image-display.spec.ts:406 | 硬编码 `/@fs/C:/Users/Administrator/...` 模块绝对路径，他人机器/CI 必失败 | `__dirname` 运行时推导传入 evaluate |
| F59 | fixtures/manual-helper.ts、utils/doc-metadata.ts | 全仓库零引用死文件 | 删除 |
| F60 | packages/react-board/src/wrapper.tsx:529-551 | 视口恢复窗口（≤30 帧）内卸载组件，window 上的捕获监听滞留至页面关闭（闭包持 board） | 卸载 effect 调 clearViewportRestoreInteractionCancel |
| F61 | packages/utils/src/indexeddb/operations.ts:348 | clearStore 在 request.onsuccess 即 resolve，违背本文件「以事务 oncomplete 为准」约定 | 对齐 put 写法 + onabort |
| F62 | scripts/reconcile-fix.py:98,259 | task_id 以 f-string 拼进 psql SQL（同文件对 JSON 已做转义、标识符未防） | run_psql 支持 `-v` 变量，`:'task_id'` 注入 |
| F63 | reconcile-fix.py:108、reconcile-upstream.py:96 | `tempfile.mktemp`（已废弃、可预测名 + TOCTOU） | mkstemp |
| F64 | reconcile-upstream.py:277-284 | 通知去重 state 在推送之前写盘：webhook 缺失/推送失败后本次发现被永久标记，资损告警不再发出 | 推送成功（或无需推送）后才落盘 |
| F65 | scripts/preview-dashboard-stats.mjs:99、preview-dev-monitor.mjs:123 | 对生成 HTML 精确字符串 replace 跳过登录壳，源文案一变即静默退化为「预览页要登录」 | replace 前检查命中，未命中 warn |

### 批次5：supabase 留痕
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F66 | supabase/functions/ai-proxy/core.ts:650 | safeRefund 吞掉退款 RPC 失败且零日志（资损路径无观测） | 补 console.warn 留痕（含 user/count） |

---

## 二、未修复问题清单

### P0 / P1（[C]，需拍板后另行处理）
- [P0][C] packages/drawnix/src/services/supabase-sync/collector-core.ts:106-123 —
  collectLocalSnapshot 的 failedSources 全仓库无消费方：任一数据源收集抛错该类型实体
  即静默缺失，引擎把「远程存在+本地缺失」判为本地已删 → 云端墓碑 → 各端真删；
  是上轮 knownRemoteKeys P0 的**独立触角**，修了持久化键集后此路径依然成立 —
  修法：runSync 透出 failedSources，非空即中止本轮或跳过墓碑步骤
- [P0][C] sync-engine knownRemoteKeys 恒真（上轮已登记，维持原判）
- [P1][C] supabase/functions/reconcile-worker/core.ts:448 — performRecovery 对全新路径
  用 Storage PUT 建新对象（Supabase Storage 新建须 POST+x-upsert）→ 线上必 404，
  「救回」退化为「一律退款」；单测 mock 掩盖 — 改 POST+x-upsert
- [P1][C] 工作区在途 WIP：auth-context.tsx recordAccountPassword 明文密码回写
  user_profiles.password 与 user_roles_is_admin.sql:58 的 revoke 冲突，现库必 42501
  失败（功能为死路径）；且明文密码方案本身即 09-15 登记 P0 — 建议放弃该功能而非恢复授权
- [P1][C] scripts/reconcile-fix.py:426-442 — `--apply` 先退款后写标注，两步非原子，
  中断重跑即双份退额（补扣路径反向同理）— 先写幂等标注再动额度
- [P1][C] services/backup-restore/backup-import-service.ts:166,194,274 — replace 模式
  逐域「先 clearAll 再多步导入」无事务，中途失败已清数据全丢 — 临时 store/快照后原子切换
- [P1][C] components/comic-creator/task-sync.ts:153-212 — 任务回填走整 pages 数组覆盖写，
  与 persistPatch（基于陈旧 latestRecordRef）互相覆盖，回填结果可被静默抹掉 — 统一写路径
- [P1][C] 两份 GeneratePage 批量视频重试无上限+超时重建不取消旧任务（上轮登记，维持）
- [P1][C] ComicCreator 页选择 effect 静默全选（上轮登记，维持）
- [P1][C] kb-image-service DJB2 判重（上轮登记，维持）

### P2（[C]，待确认，择要）
- supabase/functions/dev-monitor/core.ts:424-452 — classifyFailureDetail 与三分类判序不一致，rollup 与细分口径矛盾，污染平台错误率
- reconcile-worker 救回文件转存 `reconciled/` 前缀不在用户 oa 文件夹，huabu v2 RLS 下属主不可读
- dashboard-stats 推送每次向公开 Gitee 仓库传 `dashboard-<时间戳>.png` 无清理，push-test 放大增长
- supabase/migrations/jzxz_materials.sql:67 — tag 归一化 WHERE 与表达式口径错位（现库需补新迁移）
- sw/index.ts:4499 — 视频分支无同源 origin 检查（音频/图片有），同源需凭证视频被 omit credentials 重取
- sw/task-queue/channel-manager.ts:1111 — handleUpgradeForce 不 claim clients（native 路径有），升级后不接管旧页面
- hooks/useCharacters.ts:213 — deleteCharacter 不中止在途轮询，删除后回写已删记录
- hooks/useToolFromUrl.ts:47 — 固定 setTimeout 100ms 猜 toolboxService 就绪
- utils/asset-cleanup.ts:151 ↔ markdown-asset-embeds.ts:29 — 同名导出 extractAssetIdFromUrl 两种 URL 方言
- mv GeneratePage:733 autoFillAdjacentFrames 缺批量运行守卫（video 兄弟有）；:1301 仍传 characterReferenceUrls（video 已删）；video:1042 等五处不传 autoInsertToCanvas:false（mv 全传）——三处「修 A 漏 B」需先确认哪侧是预期
- packages/utils workflow/loop-detector.ts:322 — hashArgs 32 位哈希做循环检测签名，碰撞误杀任务（改 SHA-256 签名串变更）
- services/kb-import-export-service.ts:171 — 并行导入 + 同名查重 check-then-act，重复生成「标题 (1)」
- services/supabase-sync/apply-remote.ts:257 — 播放列表按 id **或 name** 匹配，云端同步可误改同名本地列表
- services/task-queue-service.ts:2173 — cancel 后立即 retry 被 executingTasks 防重守卫静默吞掉（与已登记写回竞态并列）
- FramePanel.tsx:3232-3496 — PPT 大纲批量生图无卸载清理（ComicCreator 已登记同族）
- apps/web-e2e snapshot-helper/test-app 静默跳过与 no-op（见下方暂缓说明）
- scripts/supabase-hotfix-check.sh:120 — docker restart 失败不检查，broken=0 即 exit 0

### P2（[B]，暂缓，理由附后）
- **在途 WIP 文件**（工作区有未提交改动，修复会混入他人任务提交，建议 WIP 落地后单独处理）：
  scripts/dingtalk-notify.mjs（--at-all 吞词、gitee/smms fetch 无超时、execFileSync 无 timeout、
  access_token 进 URL query、main() 裸调用）；
  scripts/jzxz-material-crawler.py（click_chip_verified 重复定义、known_source_ids 非 2xx 静默空集、
  login_mode 无 finally、模块级 ARGS 依赖、CATE_TAGS 学习结果不落盘）
- gemini-api/auth.ts ↔ settings-manager.ts URL 参数摄取两份实现：启动关键路径，去重需 URL 参数矩阵回归
- fetch 无超时家族新实例（remote-model-catalog discover、useResolvedAudioDurations、
  task-queue-service:1270/1531/1826、character-api、model-health、audio-api pollUntilComplete、
  sw task-queue）→ 并入已登记「补超时专项」
- sw sanitize-utils 裸 'key' 子串误脱敏 → 与主包 packages/utils security SENSITIVE_KEYS 同批统一
- services/supabase-sync/media-sync.ts:212 — 每轮媒体同步全量逐条重哈希：hash 缓存需先定义内容变更失效口径
- services/kb-search-engine.ts N+1 逐条读、workflow-submission-service workflows Map 只增不减、
  kb-save-manager fingerprintCache 只增不减：轻量性能项，随性能专项
- components 死代码但为 barrel 导出（ai-input-bar/ModelSelector、PromptSuggestionPanel、
  ttd-dialog/shared 四文件）：删除即包对外 API 变更，需拍板后随 API 清理专项
- ttd-dialog/batch-image-generation.tsx:2766 — normalizeRowParamsForModel 每行每渲染重算：需行级 memo key 设计
- utils/frame-title-utils.ts overlay 孤儿输入框 + 陈旧快照：DOM 挂载点变更属 UI 行为，需过目
- .gitlab/ci/ops.yml:157（service_role key 进 docker argv）等 CI/部署项：发版窗口专项（前四轮同判）
- apps/web-e2e e2e.config.ts / playwright.config.ts 硬编码内网地址与 anon key：与 smoke 脚本同批 env 化（前四轮同判）
- E2E 断言语义硬化（snapshot-helper 不可见静默跳过→显式失败、test-app 找不到目标静默 no-op→抛错、
  ai-input-bar/canvas-basics 条件静默跳过）：会产生真实红灯，需完整 E2E 回归窗口单独执行

## 三、待确认汇总（需拍板后另行处理）
1. **[P0] 云同步双触角**：knownRemoteKeys 恒真 + collector failedSources 无消费方，
   两条路径都会导致多设备互删；建议先在测试环境构造双设备场景复现，再定统一修法
2. **[P1] WIP 明文密码回写 user_profiles**：功能在现库跑不通（revoke 冲突），
   且明文密码入库本身是已登记 P0 —— 建议直接放弃
3. [P1] reconcile-worker PUT 404（救回退化一律退款）、reconcile-fix 双退、
   backup replace 非事务、comic 回填双写 —— 均涉资损/数据完整性
4. 三条「修 A 漏 B」行为漂移（mv/video GeneratePage）需产品确认哪侧是预期
5. 上轮已登记的存量待确认项（reconcile 锁看门狗、settings-dialog「取消」实为保存、
   GradientEditor index-key、use_template 防刷等）维持原判

## 四、整体印象（第五轮增量）
1. 五轮累计后，组件层「成对清理、竞态守卫、错误提示」纪律已基本成型，本轮新问题
   呈现清晰的**长尾分布**：60% 以上是已知家族的零星新实例（浮动 promise、updater 内副作用、
   每渲染重算、修 A 漏 B），适合按家族批量清理而非逐个修。
2. 本轮最高价值的两条都在**数据完整性**：collector failedSources 无消费方（P0 触角）
   与 comic 回填双写——共同模式是「写路径不止一条，但只有一条被设计过」，与上轮
   「纯函数正确、生产接线退化」互为镜像；建议云同步/记录回填类改动建立「写路径清单」评审习惯。
3. scripts/ 运维脚本与 supabase 函数仍无本地测试门禁，本轮对它们的修改以「失败可见化」
   为原则（留痕、告警、参数化），结构性重构继续留给部署窗口专项。
