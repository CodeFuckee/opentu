# 全仓库代码评审报告(2026-09-19,第三轮)

- **范围**:apps/web、packages/drawnix(services/mcp、utils/hooks/stores/engine/transforms/contexts、components、顶层+plugins/tools)、packages/utils、packages/react-board、packages/react-text、supabase/functions(+migrations)、scripts、apps/web-e2e、根配置/部署文件。
- **方法**:按 code-review-skill 的 typescript/react/security/quality/common-bugs 指南与 cross-cutting(SQL 注入/XSS/错误处理/并发/N+1)清单,分 6 个分区并行评审;与既有两轮报告(docs/CODE_REVIEW_PENDING_ISSUES.md、docs/code-review-2026-09-18.md)逐条去重,已登记项只核实不重复上报;对 09-18 两批重构的修复项做了回退抽查。
- **标注**:B = 行为保持可修;C = 修复必须改变行为,只报告。行号为评审时点实测。

---

## 一、本轮已修复(行为保持,两批)

### 批次1:资源清理与可观测性
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F1 | packages/drawnix/src/utils/selection-utils.ts:669-689 | `copyFillDefsToElements` 第二遍 Promise.all 内任一元素抛错 → 整体 reject,已插入 DOM 的 defs 克隆永久残留(SVG 渲染污染) | try/catch 包裹,失败路径先移除已插入 defs 再原样抛出;成功路径不变 |
| F2 | packages/drawnix/src/contexts/ModelHealthContext.tsx:146 | 子组件 effect 先于父 Provider effect 运行,子组件经 setActiveSelections 先建轮询后,Provider mount effect 无条件覆盖句柄 → 双 interval 且旧句柄永不可清 | mount effect 加 `&& !intervalRef.current` 守卫 |
| F3 | packages/drawnix/src/components/ai-input-bar/AIInputBar.tsx:777 | SelectionWatcher mouseup 回调的 50ms setTimeout 未纳入卸载清理,卸载后仍触发陈旧回调 | 句柄入局部变量,cleanup 中 clearTimeout |
| F4 | packages/drawnix/src/services/ppt/ppt-export-service.ts:1849 | 元素级 `catch (err) { void err; }` 完全静默,系统性抛错表现为整页丢文本无从排查 | 改 console.warn 带上下文,容错语义不变 |
| F5 | packages/drawnix/src/mcp/registry.ts:15,95 | useSW 死开关与误导注释(宣称 SW 优先委托,实现仅本地执行) | 注释如实描述(字段/API 保留,不做接口变更) |

### 批次2:纯结构/性能
| # | 位置 | 问题 | 修法 |
|---|------|------|------|
| F6 | packages/drawnix/src/drawnix.tsx:320,743 | options 对象与 34 项 plugins 数组(含 3 个插件工厂调用)每次渲染重建;Wrapper 仅初始化消费一次 | options 提升模块级常量;plugins useMemo([updateAppState],该 useCallback 依赖稳定) |
| F7 | packages/drawnix/src/transforms/boolean.ts ↔ precise-erase.ts | clipper 类型声明/CLIPPER_SCALE/loadClipperLib/坐标转换约 80 行逐字重复,且已开始分叉 | 抽 `transforms/clipper-shared.ts`(超集类型),两文件改导入;各自 getShapePolygon 分叉保持原样(合并属行为变更,见待确认) |
| F8 | packages/drawnix/src/transforms/boolean.ts:845 | booleanFlatten 与 booleanUnion 函数体逐字相同(ctUnion) | flatten 委托 booleanUnion,导出结构不变 |
| F9 | packages/drawnix/src/utils/selection-utils.ts:470,1218 | 双重循环内 `includes` O(n²)(overlapping 去重、remaining 过滤) | 并行 Set 哈希;remaining 过滤改为与派生数组口径严格互补的 Set 判断 |
| F10 | .dockerignore | 根目录 secret.md(真实凭据)与 test-files/ 会进 Docker 构建上下文(COPY .) | 追加忽略(交付镜像本就不含,属上下文卫生) |
| F11 | scripts/generate-manual.ts:107,127 | markdownToHtml 的 alt/href/链接文本直接内插,引号即产生畸形 HTML | 内插处调用已有 escapeHtml(内容为仓库内可信文档,纯加固) |

## 二、新问题清单(未修复,按分区)

### supabase(P0×1 + P1×1 + P2×5,均为 C)
- [P0] supabase/migrations/generation_usage.sql:329-336(同 generation_usage_user_override.sql:244-247)— 配额 RPC revoke 漏了 PUBLIC,authenticated 经 PUBLIC 仍可直调 `refund_image_quota` 清零自己用量、`consume_image_quota` 污染他人用量、`get_image_quota` 读任意用户用量(资损);后写的 user_roles_is_admin.sql:128 是正确写法 — 补 `revoke execute ... from public` 并在 DB 重跑
- [P1] supabase/functions/reconcile-worker/core.ts:702-704 — 已退款任务恢复失败时 catch 无条件再退一次(双退);补扣发生在图片下载/上传之后,中途抛错即触发 — catch 按 prevRefunded 分流或合成单个 definer RPC
- [P2] supabase/migrations/user_sync_media.sql:90-125 — yue-sync 桶策略仍按「JWT 邮箱 @ 前缀」,前端路径用 oa_account,huabu v2 修过的同类错位在此复现 — 复用 huabu_folder_name_for_current_user 同款方案
- [P2] supabase/functions/template-crawler/core.ts:441 — coverUrl(第三方上游返回)无校验直接 GET 并入公开桶,SSRF+内网读取外带 — https+域名白名单
- [P2] supabase/functions/dev-monitor/core.ts:400,404 — AUTH 关键词含裸子串 '401',errorText 为 JSON.stringify 全文,时间戳含 401 即误归「认证失败」,污染新失败归因与趋势卡 — 401 改按 httpStatus 数值判断
- [P2] supabase/functions/ai-proxy/core.ts:543-552 — 异步 submit 提取不到上游 id 时跳过记账,预扣额度无退回路径 — id 为空时立即 safeRefund
- [P2] supabase/functions/reconcile-worker/core.ts:633 vs :659 — 任务回看 3 天 vs 网关账本回看 2 天+15 分钟,最老一天任务永不匹配、静默不处置 — 两窗口对齐
- [P2] supabase/functions/dashboard-stats/core.ts:142,171 — 共享令牌只在前 100 个 token 里找、日志最多 60×100 行,画布消耗 KPI 静默封顶 — 翻页至真实尾页或返回 null 标注「数据不可用」
- [P2] supabase/migrations/storage_images_policies.sql:16-18 — images 公开桶任意登录用户无路径/大小约束上传,可作组织域名下公开内容托管 — 分桶或前缀/配额策略

### services / mcp(P1×3 + P2×9)
- [P1] services/task-supabase-archive/core.ts:303-324 + service.ts:157-231 — collectHttpUrls 深度收集 params 中任意 http(s) 字符串当参考图抓取上传,成功后把 youtubeUrl/含 URL 的 prompt 等全部替换为 bucket 路径,并向任意第三方 URL 发起 GET — 收集范围限定 referenceImages/uploadedImages 或魔数校验+不替换非媒体字段
- [P1] services/workspace-service.ts:794-822 — copyBoard 对未加载画板(LRU 淘汰/初始化桩 elements:[])复制出空白副本落库(P0-4 同根因新调用点) — 复制前先 loadBoard
- [P1] services/task-supabase-archive/service.ts:284 vs 813-848 — result 列「终态整列覆盖」与「归档读-合并-写」双写无原子性,交错即互相覆盖 — CAS 或统一读-合并-写
- [P2] services/media-executor/task-storage-writer.ts:303-318 — 1695f250 新增 updateTaskResult 延续非事务读改写,与终态写并发互相覆盖 — 与 P1-15 一并单事务化
- [P2] services/task-queue-service.ts:1304-1878(6 处)— chat 分析器链路(视频/音频分析、脚本改编、提示词、歌词、MV 分镜)不透传 AbortSignal,取消后 LLM 照常跑完 — 透传 signal
- [P2] services/media-executor/fallback-executor.ts:942 — aiAnalyze 未传取消信号(同文件 generateText 已传) — 补传
- [P2] services/canvas-audio-playback-service.ts:869-930 — startPlayback 异步窗口无会话守卫,快速连点 A→B 时 A 的慢返回覆盖 B — 递增 token 过期丢弃
- [P2] services/unified-cache-service.ts:1826-1835 — checkDBExists 恒 true 且 open 副作用会创建空库,"!exists 早退"死分支 — indexedDB.databases() 或 objectStore 判定(需评估调用方)
- [P2] services/unified-cache-service.ts:1091-1134 — deleteCacheBatch 请求级失败致事务 abort 回滚,但计数已先行返回虚高 — 以事务 oncomplete/onabort 为准
- [P2] services/task-supabase-archive/service.ts:177,634-639 — 归档 fetch 无超时无 signal,可被挂起连接永久阻塞 — AbortSignal.timeout
- [P2] mcp/registry.ts:129-131 — executeTools 无并发上限 Promise.all(同已登记二-13,补充登记 tool 增长风险)

### utils / hooks / transforms / contexts / engine(P1×2 + P2×13)
- [P1] contexts/SupabaseSyncContext.tsx:193-195,361-363 — 同步失败仍推进 lastSyncTime 基线,失败窗口内本地变更永不上传、远端变更永不下载(数据丢失类) — result.success 才推进
- [P1] transforms/precise-erase.ts:201-235 — getShapePolygon 仅实现椭圆+矩形兜底,但 canElementBePreciseErased 放行全部形状,菱形/星形等按外接矩形参与 Difference,擦除几何错误 — 复用 boolean.ts 完整实现(本轮仅完成共享抽取,几何修复属行为变更待确认)
- [P2] contexts/SupabaseSyncContext.tsx:228-231 — initializedRef 一次性守卫 + StrictMode 下首挂载 cleanup 后二挂载直接 return,dev 会话订阅永久丢失 — 订阅注册移出守卫
- [P2] hooks/useAutoInsertToCanvas.ts:1236-1247 — 分组插入多视频逐个 quickInsert 同一插入点,全部叠加 — 合成单次调用(audio 分支同款正确写法)
- [P2] hooks/useAutoInsertToCanvas.ts:1528-1530 — 每个 taskCreated 事件触发全量恢复扫描 O(任务数×workzone×steps) — 只检查新任务
- [P2] utils/runtime-model-discovery.ts:1514-1518 — discover() fetch 无超时,异常路径状态永久停留 loading — timeout + setError
- [P2] utils/settings-manager.ts:1833-1834 — resolveInvocationRoute 的 baseUrl 取 profile 而 apiKey 回退 legacy,跨供应商凭据可发往 profile 配置的任意地址 — key 回退仅当 baseUrl 同源回退(语义需确认)
- [P2] contexts/ModelHealthContext.tsx:181-193 — Provider value 未 useMemo(与已登记 menu.tsx 同族)
- [P2] transforms/boolean.ts:726 — executeBooleanOperation 删除全部选中元素,但 polygons 仅含成功闭合子集,未闭合图形被静默删除且未参与运算 — 只删 polygons 记录的元素
- [P2] hooks/useAutoInsertToCanvas.ts:894-932 — video 多 url 只插 allUrls[0] 而计数按全部 url,虚高 — 待确认视频任务是否会返回多 url
- [P2] data/video.ts:23,120 — dimensionsCache 成功结果永不过期,会话级无上限 — LRU/TTL(弱)

### components(P2×7)
- [P2] components/project-drawer/FramePanel.tsx:1520 — 依赖 orderedPPTFrames(每次 board.afterChange 因 refreshKey 重建)的 effect 把用户编辑中的 PPT 大纲草稿重置回已提交值 — deps 收敛为内容签名
- [P2] components/project-drawer/ProjectDrawer.tsx:1579 — 连续切换画板无过期守卫,慢请求回来覆盖新画板(P1-10 同族独立实例) — requestId 守卫
- [P2] components/video-analyzer/pages/GeneratePage.tsx ≈ mv-creator/pages/GeneratePage.tsx — 约 1900 行(72%)逐行复制粘贴变种,批量视频生成全链路两套 — 抽公共 hook+共享子组件(专项)
- [P2] components/ttd-dialog/shared/ImageUpload.tsx:354 — 可删除列表 index 作 key,删中间项后 hover 态挂错(与已登记 ReferenceImageUpload 同型) — 稳定 key
- [P2] components/ttd-dialog/batch-image-generation.tsx:944,2400,2445-2446,2559 — 组件剪贴板/编辑态挂 window 全局(__copiedCells 等),卸载仍存活、跨实例共享 — useRef
- [P2] components/ai-input-bar/AIInputBar.tsx:778 — 同 F3(已修)
- [P2] 巨石文件 top5 仍成立(AIInputBar 5241 / FramePanel 4219 / batch-image-generation 3886 / settings-dialog 3198 / ComicCreator 3085),拆分需专项

### 外围包 / drawnix 顶层(P2×6)
- [P2] packages/utils/src/download/index.ts:144-154 — processBatchWithConcurrency 部分失败后其余 worker 继续空跑且再失败成 unhandled rejection(crash-logger 误报) — allSettled 收敛后 rethrow 首错(契约不变)
- [P2] packages/drawnix/src/plugins/with-tool.ts:206-208,264-266 — toolId 未转义拼 querySelector(P1-23 同族两处,iframe postMessage 可控) — CSS.escape 或 id→映射
- [P2] packages/drawnix/src/plugins/with-text-link.tsx:60-63 — ReactEditor.toSlateNode(undefined as Editor, ...) 依赖 slate-dom「editor 参数未使用」的实现巧合,升级即碎 — 沿 afterInit 传真 editor
- [P2] packages/drawnix/src/drawnix.tsx:320,743 — 同 F6(已修)
- [P2] packages/utils/src/media/video.ts:382-386 — formatVideoTimestamp 秒位进位边界输出 "0:60.0" — 先取整总秒再拆分(当前无调用方)
- [P2] packages/drawnix/src/drawnix.tsx:1216,1287 — 媒体编辑器产物 fetch 未查 response.ok,错误页可入 Cache — 补检查

### scripts / E2E / 部署(P0×1 + P1×4 + P2×8)
- [P0] Dockerfile:5 `COPY .` + .dockerignore — secret.md/test-files 进构建上下文与 builder 层 — 同 F10(已修 .dockerignore)
- [P0] scripts/upload-and-deploy.js:74、create-deploy-package.js:204,289、upload-nginx-config.js:68,100 — sshpass -p 明文密码进 argv(ps 可见),仓库内 rollback-hybrid.js:167 已有数组参数正确先例 — 统一改 -e/stdin(部署链,发版窗口专项)
- [P1] scripts/generate-manual.ts:906 — main().catch(console.error) 失败仍退出 0 — exit(1)
- [P1] scripts/publish.js:18-20 — npm publish 失败被吞,进程退出 0 — 累计失败 exit 1
- [P1] scripts/crawl-templates.sh:25-41 — curl 无 -f 无 set -e,后端宕机空转后以 0 退出 — 失败即 exit 1
- [P1] scripts/dingtalk-notify.mjs:138,158,452(WIP 文件)、cleanup-e2e-users.mjs:62、repair-task-media.mjs:181、edge-function-smoke.mjs:49 — fetch 无超时,上游挂起即卡死 — AbortSignal.timeout(项目已有先例)
- [P2] scripts/test-runner.mjs:192-196 — 用户输入不完整转义进 spawn(shell:true) — 数组参数(注意 Windows 兼容)
- [P2] scripts/safe-version-bump.js:151、update-version.js:38 — GITHUB_SHA 应为 CI_COMMIT_SHA(GitLab CI 中恒 unknown)
- [P2] scripts/create-deploy-package.js:194,333,845 — usePassword 死参数/死字段(遮蔽形参、返回值无此字段) — 清理
- [P2] scripts/release-version.js:13 — git add . 会把无关未忽略文件卷进 release 提交 — 显式列出产物
- [P2] scripts/upload-and-deploy.js:115,121,269 — 远程命令 ${dir} 未引用、rsync -e 内嵌引号 — 复用 rollback-release shellEscape
- [P2] scripts/cleanup-e2e-users.mjs:36,129 — --pattern 自定义正则决定全库删除目标,--apply 下宽松正则误删真实用户 — 校验锚定 @yjk\.com$
- [P2] scripts/deploy-hybrid.js:1096、publish-npm.js:255、publish-cdn-assets.js:289 — --otp= 进 argv/日志 — NPM_CONFIG_OTP
- [P2] 全部部署脚本 StrictHostKeyChecking=no(有意取舍,登记)

## 三、待确认(行为变更/需产品或 DB 决策,未动)

1. **[P0] supabase 配额 RPC revoke PUBLIC**(见上)— 需在 DB 以属主执行 revoke,并收编 configs/reconcile_state 两表 DDL(不在仓库内;若未做 RLS+revoke,任何登录用户可直读全部网关凭据 = 网关接管,请在 DB 验证 `relrowsecurity` 与 `\dp configs`)
2. **[P1] SupabaseSyncContext 失败仍推进基线**(数据丢失类,修法一行,语义变更需确认)
3. **[P1] precise-erase 形状几何**(修复=改擦除结果;共享函数已就绪,确认后一行切换)
4. **[P1] workspace-service copyBoard 空副本**(修法=复制前 loadBoard,改加载时序)
5. **[P1] reconcile 双退**(修法见上;涉资损语义)
6. **[P1] scripts 三件套退出码**(generate-manual/publish/crawl-templates 失败改 exit 1,影响 CI 判定)
7. 其余 P0-1~P0-6(09-18 登记:明文密码、oaAccount 归属、apiKey 下发 iframe、deleteDatabase 文案匹配等)维持原判待确认
8. USAGE_MULTIPLIER 看板倍数、images 桶策略、yue-sync RLS 收敛、checkDBExists 死分支激活影响面、with-text-link editor 传递、test-runner Windows 兼容——动前逐项拍板

## 四、已修项回退抽查结论(全部无回退)

- 09-18 批次1(transforms/utils)9/9 在位;distribute 参数化、buildTuziProfileVariant、message-utils、common no-op、task-utils 死代码、selection-utils 分区+Map、runtime-model-discovery 去重、photo-wall-splitter 头指针 BFS、data/audio 正则外提。
- 09-18 批次2(components/hooks/web)7/7 在位:MediaLibraryModal、ProjectDrawer、EnhancedChatInput、useTaskQueue、useChatSessions、Minimap(useMemo+卸载清理)、crash-logger 死变量、channel-manager 空 clear、permissions-policy-fix Set、VirtualTaskList。
- 更早批次:管理门禁 is_admin fail-closed、dashboard-stats anon key 兜底移除、newapi-key/sync-staff-profile userId 校验、user_profiles 写权收权+role 触发器、aes-gcm encrypt 抛错、image.ts 透明 PNG 格式选择、secure-context FNV-1a 兜底(postMessage/剪贴板/Notification 降级亦在位)。
- crash-recovery blockedTaskIds 已不存在(旧登记可销)。

## 五、整体印象(第三轮增量)

1. 三个分区(supabase 后端、services 归档链路、同步基线)是本轮新问题的集中地——基本都是 08-30 之后快速迭代代码(reconcile/dev-monitor/归档加固)引入的;两轮评审覆盖过的老代码反而干净。
2. 组件层质量明显好于前两轮印象:监听器/定时器成对清理、requestId 竞态守卫、XSS 消毒已成惯例;本轮组件层新问题全是 P2。
3. 最高优先级建议:先做「待确认 1」的 DB 验证(configs 表若裸奔即 P0),再依次处理双退、同步基线、归档 URL 收集三个 P1。
