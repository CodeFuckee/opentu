# 全仓库代码评审报告(2026-09-18)

- **范围**:apps/web、packages/drawnix、packages/utils、packages/react-board、packages/react-text、supabase/functions(+migrations)、scripts,约 12 万行 TS/TSX/SQL。
- **方法**:按 code-review-skill 的 typescript/react 指南与 cross-cutting(安全/错误处理/并发/N+1/XSS/SQL 注入/通用质量)清单,分 10 个分区逐文件评审,五维度:架构、性能、安全、质量反模式、常见 bug。关键 P0/P1 均经人工二次核实。
- **标注**:`[WIP]` = 该文件当前有未提交改动(上一会话遗留),按约定本轮重构**不触碰**,问题仅登记。
- **处置口径**:行为保持的重构只做"不改对外行为/接口"的项;凡需改变行为的 bug 修复一律列入「待确认」,经确认后另行处理。

---

## 一、P0(安全 / 资损 / 数据丢失)

| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P0-1 | [WIP] apps/web/src/supabase/auth-context.tsx:78 | 注册/登录成功后把**明文密码** upsert 到 `user_profiles.password`(自述"供开发者测试登录") | 若仅内网用:至少加环境开关,生产构建绝不回写;公网版本应移除该链路并清洗历史数据 | 待确认(有意设计,见 CHANGELOG 2026-09-17 条目;生产行为需用户拍板) |
| P0-2 | [WIP] supabase/migrations/user_profiles_add_password.sql:14 | 为上条新增明文密码列;service_role/备份泄漏即全量凭据泄露(newapi_password 同为明文) | 同上;newapi_password 建议改加密存储或管理 API 免密换 token | 待确认(同上) |
| P0-3 | supabase/functions/newapi-key/index.ts:63 | `oaAccount` 取自请求体且不校验归属(userId 已校验 == caller,oaAccount 未校验);core.ts 对平台已存在同名账号走管理员重置密码 | 强制 `oaAccount` 与 JWT 邮箱 @ 前缀一致,不一致 403 | 待确认(行为变更,安全修复) |
| P0-4 | packages/drawnix/src/services/workspace-service.ts:628 | 初始化时 `this.boards` 全部为 `elements:[]` 元数据桩(:119),moveBoard/moveFolder/reorder/deleteFolder 对未加载画板把桩整条 `saveBoard` 回写 IndexedDB,**拖动未加载画板即清空其内容** | 保存前 loadBoard 合并真实 elements,或存储层只更新元数据字段 | 待确认(行为变更,数据丢失修复) |
| P0-5 | packages/drawnix/src/plugins/with-tool.ts:69 | 工具 iframe 就绪即把 `settings.apiKey` 明文 postMessage 下发,任意第三方自定义工具页可拿到 API Key | 默认不下发密钥,宿主代理请求或工具域白名单 | 待确认(行为变更,安全修复) |
| P0-6 | packages/drawnix/src/services/workspace-storage-service.ts:244(配套 P1) | 初始化失败仅凭错误文案含 "version" 就 `deleteDatabase` 整库重建,无关错误也会清空全部画板 | 收窄为精确版本冲突错误码,重建前先导出备份 | 待确认(行为变更) |

## 二、P1(正确性 / 性能 / 泄漏)

### supabase 后端
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-1 | supabase/functions/sync-staff-profile/core.ts:155 | `oaAccount` 无归属校验,可冒领他人部门/姓名,结合 RLS 可读他人归档文件夹 | 校验 `oaAccount+'@yjk.com' === JWT email` | 待确认(行为变更) |
| P1-2 | supabase/functions/ai-proxy/core.ts:561 | `.text()` 消费 body 后调 `.clone()` 必抛 TypeError,记账重试是死代码;上游成功客户端却可能收 500 | 消费前保留 clone 副本 | 待确认(行为变更) |
| P1-3 | supabase/functions/reconcile-worker/core.ts:506 | 退款 RPC→回读→patch 标注非原子:RPC 失败仍标已退(没退到);patch 失败下轮再退(双退) | 先写幂等标注再退款,或合成单个 definer RPC | 待确认(行为变更) |
| P1-4 | supabase/migrations/generation_usage.sql:309 | `refund_task_bill` select 未加 FOR UPDATE,并发轮询同任务可双份退款 | `update ... where refunded=false returning` 按行数退额 | 待确认(行为变更) |
| P1-5 | supabase/functions/reconcile-worker/core.ts:288 | 网关账本只拉 p=1&page_size=500 无翻页,超 500 条静默截断漏对账 | 按 total 循环翻页 | 待确认(行为变更) |
| P1-6 | supabase/functions/check-email/core.ts:39 | 匿名无鉴权无限流端点每次翻页拉最多 5 万 auth 用户,邮箱枚举+DoS 放大 | `email=eq.` 精确查询或限流 | 待确认(行为变更) |
| P1-7 | supabase/functions/dashboard-stats/core.ts:1255 | `limit=50000` 单页拉全量在 JS 聚合,超限统计静默失真(dev-monitor:811 同) | SQL 聚合/RPC 或分页循环 | 待确认(行为变更) |

### apps/web
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-8 | [WIP] apps/web/src/supabase/auth-context.tsx:207 | useEffect 依赖整个 status 对象,每次会话事件重复装配路由/归档/同步/模板库 | 依赖收敛为 `state==='authenticated'` 布尔 | 待确认(WIP 文件) |
| P1-9 | [WIP] apps/web/src/supabase/auth-context.tsx:212 | signUp/signIn 网络失败直接 throw,表单只处理返回 error,用户无提示 + unhandledrejection | 包 try/catch 转 `{error}` | 待确认(WIP 文件) |
| P1-10 | apps/web/src/app/app.tsx:551 | handleBoardSwitch await 后才写状态,快速切画板慢响应覆盖新画板数据(无序号守卫) | 递增 requestId 丢弃过期回调 | 待确认(行为变更) |
| P1-11 | apps/web/src/supabase/supabase-client.ts:12 | 内网地址+anon key 硬编码 fallback 打进生产 bundle | env 缺失 fail-fast(内网部署需确认拆分方案) | 待确认 |
| P1-12 | apps/web/src/sw/index.ts(6868 行) | 单文件十余种职责,无法单测 | 按域拆模块 | 暂缓(结构性大重构,需专项) |
| P1-13 | apps/web/src/utils/sw-console-capture.ts:275 等 | channel 未就绪时每 500ms 无上限递归轮询(bootstrap.tsx:610/651 同) | 加最大重试/退避 | 暂缓(涉及启动时序,行为微变) |

### services(任务/媒体核心)
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-14 | [WIP] media-executor/task-storage-writer.ts:136 | `indexedDB.open` 不带版本号,若先于 app-database 建库则只有 tasks store,workflows/config 永缺 | 改用 getAppDB() | 待确认(WIP 文件) |
| P1-15 | [WIP] media-executor/task-storage-writer.ts:224-337 | updateStatus 等均为「读→改→写」两个独立事务,并发互相覆盖 | 同一 readwrite 事务内读改写 | 待确认(WIP 文件) |
| P1-16 | [WIP] media-executor/task-storage-writer.ts:399-448 | importTasks onerror 未 preventDefault,单条失败整批回滚 | onerror 中 preventDefault | 待确认(WIP 文件) |
| P1-17 | services/task-queue-service.ts:1115 | 外层等待硬编码 15 分钟超时,adapter 轮询上限约 90 分钟,长视频任务 UI 永久 processing | 超时与执行器对齐 | 待确认(行为变更) |
| P1-18 | services/generation-api-service.ts:234 | Promise.race 超时获胜后落败 promise 无消费者(unhandled rejection);resume 系列超时不 abort,后台空转 | 挂 catch + 超时 abort | 待确认(行为变更) |
| P1-19 | services/model-adapters/context.ts:75 | AbortSignal 不透传,kling/seedance/happyhorse 取消后仍轮询约 90 分钟 | context 透传 signal | 待确认(行为变更) |
| P1-20 | services/workflow-engine/engine.ts:199 | continueOnError 时失败步骤的下游 pending 永久跳过,工作流卡死 running | 下游标 skipped 且整体判 failed | 待确认(行为变更) |

### services(其余子域)
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-21 | services/workspace-export-service.ts:262 | merge:false 先 clearAll 再逐条导入,无事务,中途失败数据全丢 | 先入临时库再原子切换 | 待确认(行为变更) |
| P1-22 | services/video-merge-webcodecs.ts:272,337,415,84 | play 失败合并永久挂起且资源不清理;假时长 `length*8`;先全量 fetch 进内存不用;decodeVideo 死代码且帧不 close | reject+finally 清理;真时长;删无用下载;删死代码 | 待确认(行为变更) |
| P1-23 | services/tool-communication-service.ts:262 | toolId 未转义拼进 querySelector,畸形 id 抛 SyntaxError | CSS.escape 或 id→iframe 映射 | 待确认(行为变更) |
| P1-24 | services/long-video-chain-service.ts:150 | 片段完成但无 videoUrl 不计入 completed,批次永不合并(泄漏+卡死) | 无 URL 也视为完结走失败路径 | 待确认(行为变更) |
| P1-25 | services/kb-save-manager.ts:398 | 32 位 DJB2 指纹判重,碰撞即静默丢保存 | SHA-256 | 待确认(行为变更) |

### 状态层 / 引擎 / 组件
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-26 | hooks/useChatHandler.ts:147 | addMessage 等在 try 外,reject 使 isSendingRef 永久 true,之后所有消息静默不发 | 锁释放挪入 finally | 待确认(行为变更) |
| P1-27 | hooks/useChatHandler.ts:284 等 | 存储调用 floating promise,落盘失败即 unhandled rejection | await/.catch | 待确认(行为变更) |
| P1-28 | hooks/useChatHandler.ts:416 | regenerate 只裁剪 UI,rawMessagesRef 与存储旧回复残留,上下文重复 | 同步截断 raw+持久化 | 待确认(行为变更) |
| P1-29 | hooks/useInfinitePagination.ts:265 | fetcher 内联时每次渲染重建并重新触发请求,无限 refetch | ref 持有 fetcher | 待确认(行为变更) |
| P1-30 | engine/workflow/engines/WorkflowEngine.ts:406 | parameterMapper.map 在 try 外,toJSON 裸 JSON.parse,一次映射异常中止整个工作流 | 纳入 try 降级 | 待确认(行为变更) |
| P1-31 | plugins/with-tool.ts:346 + tool-communication-service.ts:144 | 每次 board 初始化 new Service 且从不 destroy,message 监听与 60s interval 持续泄漏 | 销毁路径调 destroy() | 待确认(行为变更) |
| P1-32 | drawnix.tsx:825 | 每次选择变化都写新数组更新单一 appState,全 context 消费者重渲染 | 浅比较/拆分 context | 暂缓(需性能基准验证) |
| P1-33 | contexts/AssetContext.tsx:686 | 每个音频条目对全量列表 some() 查封面,O(n²) | 预建 Map | 暂缓(行为保持但改动面大) |
| P1-34 | components/canvas-search/canvas-search.tsx:75 | 带 g 标志正则反复 test,lastIndex 残留导致搜索随机漏配 | 去 g 标志 | 待确认(修复会改变搜索结果,属行为变更) |
| P1-35 | components/ai-input-bar/AIInputBar.tsx:862 | loadAIInputPreferences 每次渲染执行(5000 行组件,输入每字符触发) | useMemo 惰性初始化 | ✅ 已纳入重构批次2 |
| P1-36 | components/chat-drawer/ChatDrawer.tsx:358 等 | setWorkflowMessages updater 内做持久化/setTimeout 副作用,StrictMode 双触发 | 副作用移出 updater | 暂缓(涉及时序,需专项验证) |
| P1-37 | components/project-drawer/FramePanel.tsx:1202,1245 | 覆写 board.afterChange + rAF 每帧 JSON.stringify 轮询 | 订阅变更事件 | 暂缓(轮询→订阅属机制更换) |
| P1-38 | components/multi-selection-handles/multi-selection-handles.tsx:129 | 同款 rAF 每帧 stringify | 同上 | 暂缓(同上) |
| P1-39 | components/minimap/Minimap.tsx:106 | config 每渲染新对象使 100ms 渲染 interval 反复拆建 | useMemo | ✅ 已纳入重构批次2 |
| P1-40 | components/task-queue/VirtualTaskList.tsx:294,364 | 组件体内定义组件(每渲染重挂);memo 组件传内联回调致 memo 失效 | 294 已改 JSX 元素 ✅;364 需改 TaskItem prop 签名(两个消费方,接口调整)暂缓 |
| P1-41 | components/retry-image.tsx:310 | src 切换后旧 Promise 落地覆盖新图且 blob URL 泄漏 | cancelled 标志 | 待确认(行为变更) |
| P1-42 | components/toolbox-drawer/ToolWinBoxManager.tsx:423 | iframe sandbox `allow-scripts allow-same-origin` 等同无沙箱,配合 apiKey 注入 | 收窄 sandbox | 待确认(行为变更) |

### utils / 公共包
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-43 | utils/settings-manager.ts:1492(另 gemini-api/auth.ts:179) | 占位符正则把纯字母数字串误判为占位符,纯文本 API Key 被静默丢弃 | 只匹配花括号/${ 形态 | 待确认(行为变更) |
| P1-44 | utils/image-generation-anchor-task.ts:185 | sort 原地突变调用方数组 | `[...tasks].sort` | 待确认(行为变更,虽小) |
| P1-45 | utils/gemini-api/apiCalls.ts:943 | `temperature||0.5` 等 falsy 替换,显式 0 不生效 | 改 `??` | 待确认(行为变更) |
| P1-46 | utils/gemini-api/apiCalls.ts:1014 | callVideoApiStreamRaw SSE 无跨 chunk lineBuffer,JSON 行解析失败被吞 | 抽共享 SSE 读取器 | 暂缓(与 P2 去重合并做需专门测试) |
| P1-47 | utils/gemini-api/services.ts:638 | resultText += 累积全文导致日志重复累计 | 改赋值 | 暂缓(仅日志,低价值) |
| P1-48 | utils/photo-wall-splitter.ts:536 | queue.shift() O(n) BFS,大图最坏 O(n²) 冻结主线程 | 索引队列 | ✅ 已纳入重构批次1 |
| P1-49 | utils/crypto-utils.ts:25 | 设备 ID 用 Math.random 充当加密口令种子,可预测 | crypto.getRandomValues | 待确认(行为变更) |
| P1-50 | utils/validation-utils.ts:176 | `params.seed &&` 使合法 seed=0 被丢弃 | `!== undefined` | 待确认(行为变更) |
| P1-51 | utils/virtual-media-url.ts:29 | 只认 /audio/ 子前缀,image/video 不进缓存兜底链路 | 整体前缀匹配 | 待确认(行为变更) |
| P1-52 | utils/selection-utils.ts:722 | sort comparator 内 findIndex,O(n²·log n) | 预建 Map | ✅ 已纳入重构批次1 |
| P1-53 | packages/utils/src/workflow/parser.ts:449 | 裸数组分支未排除 args===null,下游 Object.keys(null) 崩溃 | 补 null 过滤 | 待确认(行为变更) |
| P1-54 | packages/react-text/src/text.tsx:78 | useMemo 内调 afterInit 副作用,StrictMode 双 editor | 移到 useEffect | 待确认(行为变更) |
| P1-55 | packages/react-board/src/plugins/with-react.tsx:67 | 初始化时序窗口内 isReadOnly(undefined) 抛错 | 判空 | 待确认(行为变更) |

### scripts
| # | 位置 | 问题 | 建议修法 | 处置 |
|---|------|------|----------|------|
| P1-56 | scripts/publish.js:18 | publish 失败仍退出 0,CI 误判成功 | catch 内 exit(1) | 待确认(行为变更) |
| P1-57 | scripts/create-deploy-package.js:204 等 | sshpass -p 明文密码进 argv(ps 可见);echo 密码进远端命令(upload-nginx-config.js:199) | sshpass -e / stdin 传密码 | 待确认(部署链行为变更) |
| P1-58 | scripts/safe-version-bump.js:361 | git commit 失败仍继续打 tag,tag 指向旧 HEAD | 失败即中止 exit(1) | 待确认(行为变更) |
| P1-59 | [WIP] scripts/dingtalk-notify.mjs:478 | server.close 等全部连接关闭,浏览器长连接使进程挂而不退 | closeIdleConnections | 待确认(WIP 文件) |
| P1-60 | scripts/repair-task-media.mjs:110 | 无 limit 全量拉行进内存才 slice | limit 下推查询 | 待确认(WIP 关联脚本) |
| P1-61 | scripts/create-deploy-package.js:845 | 读取恒为 undefined 的 usePassword,传参契约断裂 | 删参数或真正透传 | 待确认(行为变更) |

## 三、P2(可读性 / 去重 / 复杂度)

> P2 按处置归并:✅ = 本轮重构批次修复;⏸ = 暂缓(理由附后);❓ = 待确认。

**✅ 纳入本轮重构(行为保持)**
- packages/drawnix/src/transforms/distribute.ts:30-154 — distributeHorizontal/Vertical 除轴向外逐字相同 — 参数化轴向 — 批次1
- packages/drawnix/src/utils/settings-manager.ts:535-656 — buildTuziOriginal/Mix/Codex/Business 四份逐字重复 — 提取参数化工厂 — 批次1
- packages/drawnix/src/utils/gemini-api/message-utils.ts:132-148 — `isFile(a)?X:X` 两分支相同;startsWith('/') 使前两个前缀判断冗余 — 简化 — 批次1
- packages/drawnix/src/utils/common.ts:287-289 — 三个 no-op replace — 删除 — 批次1
- packages/drawnix/src/utils/task-utils.ts:40-49 — hasAsyncImageInvocationRoute 全仓库无调用 — 删除死代码 — 批次1
- packages/drawnix/src/utils/selection-utils.ts:451-467 — 同一数组两次 filter — 一次遍历分区 — 批次1
- packages/drawnix/src/utils/runtime-model-discovery.ts:1222 — 同参数连续计算两遍 — 算一次复用 — 批次1
- packages/drawnix/src/utils/data/audio.ts:44-52 — 字符循环内每字符 3 次正则 test — 正则提至循环外 — 批次1
- components/media-library/MediaLibraryModal.tsx:124-165 — handleDoubleClick 与 handleUseAsset 逐行相同 — 合并 — 批次2
- components/project-drawer/ProjectDrawer.tsx:1107 — if/else 两分支完全相同 — 无条件调用 — 批次2
- components/chat-drawer/EnhancedChatInput.tsx:99-100 — hasExplicitContent 与 hasSelection 定义相同 — 合并 — 批次2
- hooks/useTaskQueue.ts:80-81 — totalCountAtom 与 loadedCountAtom 实现完全相同 — 合并 — 批次2
- hooks/useChatSessions.ts:62 — deps [sessions.length] 无实际引用 — 改 [] — 批次2
- components/minimap/Minimap.tsx:797 — 卸载后 setTimeout 仍 setState — 记录句柄并在 cleanup 清理 — 批次2
- apps/web/src/crash-logger.ts:217 — 死变量 frameCount — 删除 — 批次2
- apps/web/src/sw/task-queue/channel-manager.ts:93 — 构造器内 clear() 清刚建的空 Map,纯空操作 — 删除 — 批次2
- apps/web/src/utils/permissions-policy-fix.ts:43 — beforeUnloadHandler 单引用多注册覆盖 — 改 Set — 批次2

**⏸ 暂缓(结构性/大改动面/需专项)**
- sw/index.ts:1251 logSWDebug 空操作但数百调用点仍构造日志对象;:3347 升级分支整段复制 — 拆分 sw/index.ts 时一并处理(P1-12 专项)
- supabase dev-monitor/dashboard-stats 约 400 行逐行复制(verifyAdmin/readConfig/登录壳) — 抽 `_shared/` 需验证边缘函数打包,待专项
- services:resolveUsername/sanitizeUsername/sha256Hex/MIME 映射 4+ 处复制;baseUrl 归一化 6 处复制;7 段模拟进度样板;gemini-api 三份流式读取循环;asset-cleanup 匹配块重复;sw-capabilities 两 insert handler 大段复制;prompt-storage 三份近似;extraction 95% 重复;workspace moveBoard/moveFolder 70 行变种;video-api 三段 fetch→blob→append 复制 — 均为安全去重但跨多文件,建议逐域专项偿还
- 巨石文件:AIInputBar(handleGenerate 1125 行)、ComicCreator(2500 行)、FramePanel(4219 行)、settings-dialog(3198 行)、batch-image-generation(3886 行) — 拆分需专项
- 轮询改订阅:FramePanel/multi-selection-handles rAF stringify、ViewNavigation 与 Minimap 两份 100ms viewport 轮询、AIInputBar 500ms 空态轮询、SupabaseSyncContext 500ms 配置轮询 — 机制更换需回归验证
- performance-panel 拖拽每次 pointermove 写 localStorage;settings-dialog areEqual 双向 stringify 深比较;settings-manager 每次更新 3 次深拷贝+全监听器触发 — 性能优化需基准
- packages/utils format/裁剪/trim 五组复制粘贴 API 收敛(公共包接口变更,需 deprecated 过渡)
- scripts:五处部署 env/SSH 构建复制;Tarjan 两份实现;build-all-gifs buildAll/buildOne 50 行重复 — 脚本层专项
- components/popover 类名硬编码互斥;KnowledgeBaseContent 死代码+拖拽重挂监听;SideDrawer 拖拽重挂监听;ChatDrawer 拖拽重挂监听;UserMessageBubble 字符串解析元信息;__kbPendingNavigation 全局变量;__executeWorkflowRetry 猴子补丁;ToolWinBoxManager 原地改共享状态;ttd-dialog 两份归一化;ReferenceImageUpload key=index;ModelBenchmarkWorkbench rAF+setTimeout 时序 guard;menu.tsx context value 未 memo;chat-messages 长列表未虚拟化 — React 习惯类,建议随巨石组件拆分逐个处理
- useAutoInsertToCanvas 1200 行单 effect 闭包 — 抽纯函数模块需专项
- mcp/tools/image-generation.ts:314 description 加载期内插当前模型,切换后 LLM 看到旧值;with-video 每次 onChange 全量迁移扫描;plugins/with-tool.ts:216 订阅泄漏与去重 Map 永久拒绝;use-global-mouse-position 无节流;useTaskExecutor 每轮 console.warn 全量统计;agent-executor maxIterations 形同虚设;model-health-service 失败不节流;asset-storage 全表查重;external-skill 全量读包线性查找;kv-storage 每次开关库;unified-cache getAllKeys().slice(-1000) 字典序非时间序;task-storage-reader 全表 cursor 计数;updateTaskStatus 存根 type 硬编码 VIDEO;restoreTasks 复用 taskCreated 事件;crash-recovery/blockedTaskIds 只增不减;insertedTaskIds 只增不减;setTimeout(removeWorkZone) 无清理;AssetContext 渲染期副作用与 idle 句柄未清理;canvas-insertion 九参含五布尔 — 均登记,建议按域批量修复
- apps/web:index.html 中文域名死分支;index.html 与 bootstrap.tsx CDN 偏好双实现;sw/index.ts:6616 CORS 失败返回 200 空体;:5619 Range 无边界校验;vite.config 裸 writeFileSync;bootstrap 轮询无上限;ErrorBoundary 占位注释 — 随 sw 专项处理

**❓ 待确认(P2 类,行为可能微变或依赖外部约定)**
- supabase:500 错误回传 error.message(check-email/task-monitor/feedbackland-sso);CORS 一律 *;Gitee access_token 拼 URL;template-crawler query 未编码;钉钉通知两处口径不一(加签 vs 不加签);newapi-key token 名并发碰撞;ai-proxy 32MB body 全量解码分类、auth 5xx 与 401 不分;generation_usage exception others 吞错;reconcile rest() 未走注入 fetch;PLATFORM_USERNAME 硬编码
- web:index.html `hostname==='Yue画布.ai'` 中文串死分支(疑为本想写真实域名,修复属行为变更)
- utils:settings-manager `getSetting.call` 借 this hack;URL 模板把明文 apiKey 拼进工具 URL 并随事件广播;download-utils ZIP 条目名路径分隔未过滤;data/blob.ts FileReader 无 onerror(失败永久 pending);gemini-api/auth.ts confirmBtn 无 catch 弹窗可能永不关闭;image-splitter 与 selection-utils 功能重复函数
- 公共包:logger 顶层 import.meta.env.DEV 非 Vite 环境崩;security sanitizeObject 环状对象栈溢出;>30 位纯字母数字一律判 key 误伤;aes-gcm 静默降级 Base64;device generateDeviceId Math.random;isVolcesDomain 厂商域名进通用包;react-board wrapper 调试链路死代码;board.tsx mount-only effect 引内联回调;react-text 13 处 (leaf as any);use-board 报错文案复制粘贴错误
- 脚本:update-version GITHUB_SHA 应为 CI_COMMIT_SHA;safe-version-bump GitHub commit 死链;deploy-hybrid POSIX env 前缀在 Windows 必败;start-local-prod-supabase exit 钩子异步 taskkill;cleanup-e2e-users 串行 N+1 删除;repair-task-media existingPaths 部分缺失全量重下重复写入;upload-and-deploy releases 目录魔法推导; StrictHostKeyChecking=no 普遍禁用

## 四、整体架构印象

1. **后端(edge functions)**:统一「index 壳 + 纯逻辑 core + 注入 fetch 单测」结构一致,门禁 fail-closed 与配额 SQL 原子条件更新设计扎实;最大隐患是身份链上「oaAccount 由客户端自报」的系统性信任缺口与对账链路多处非原子。
2. **前端**:韧性强(启动恢复、缓存分层、监控齐备),XSS/消息安全面干净(Markdown/Mermaid/URL 均消毒、target=_blank 带 rel);主要债务是巨石文件、轮询代替订阅、以及近一个月快速迭代留下的复制粘贴。
3. **最高优先级建议**:P0-1/P0-2(明文密码,生产行为需拍板)、P0-3/P0-5(账号接管/API Key 外泄)、P0-4(拖动画板丢数据)应先于一切重构处理。
