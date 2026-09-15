# 代码评审遗留问题清单（2026-09-15 全仓库评审）

> 来源：2026-09-15 全仓库五维度代码评审（架构/性能/安全/反模式/常见 bug）。
> 当次已修复 37 条（见 CHANGELOG Unreleased「🔒 Security」「🐛 Bug Fixes」），本文档
> 记录**暂缓**与**待确认**问题，供后续按批次整改。行号以评审时点为准，动工前先核对。
>
> 约定：
> - **[暂缓]**：修法明确，因验证成本/改动风险/需专项窗口而未动，可直接排期修复。
> - **[待确认]**：涉及产品/部署决策，先确认再动，不要直接改。

## 一、脚本与部署（[暂缓]；建议发版窗口专项处理，改动需真实部署验证）

- [P1] .gitlab/ci/release.yml:72 — git push 把 GIT_PUSH_TOKEN/CI_JOB_TOKEN 内嵌 URL，
  push 失败时 fatal 输出会把带凭证的 URL 打进 job log — 改 http.extraheader/credential
  helper，并把相关 CI 变量配置为 masked。
- [P1] .gitlab/ci/release.yml:109 — deploy 阶段 `git checkout -f origin/main`，build 与
  deploy 之间若有新 push 会把未过测试的提交发上线 — 改 checkout 本次 CI_COMMIT_SHA 或
  tip≠构建 SHA 时 fail-fast。
- [P1] scripts/upload-nginx-config.js:199,238 — sudo 密码经 `echo '<pw>' | sudo -S` 拼进
  ssh 远程命令串，明文留在两端 ps — 改 stdin 传 `sudo -S` 或免密 sudo。
- [P1] scripts/create-deploy-package.js:204,289、upload-and-deploy.js:74、
  upload-nginx-config.js:68,100、rollback-hybrid.js:167、rollback-release.js:188 —
  `sshpass -p` 明文密码进 argv — 统一改 `sshpass -e` + SSHPASS 环境变量。
- [P2] .gitlab/ci/ops.yml:128 — schema 以 ON_ERROR_STOP=0 应用后仅凭单表存在性判断，
  check 失败即 `DROP DATABASE feedbackland WITH (FORCE)`，瞬时故障可能清库 — 核心段改
  事务 + ON_ERROR_STOP=1，重建分支加显式确认变量。
- [P2] scripts/create-deploy-package.js:229 等 5 处 — SSH 全局禁用主机密钥校验（中间人
  风险）— 改 accept-new 或固定 known_hosts。
- [P2] scripts/upload-and-deploy.js:115,316,328 — 远端命令 `${dir}`/`${tarName}` 未引用/
  转义（rollback 脚本已有 shellEscape 可复用）。
- [P2] scripts/deploy-hybrid.js:1096、publish-cdn-assets.js:289、publish-npm.js:255 —
  npm OTP 以 `--otp=` 进 argv/日志 — 改 NPM_CONFIG_OTP 环境变量。
- [P2] deploy/feedbackland/docker-compose.yml:28 — 必填机密用裸 `${FL_DATABASE_URL}`，
  缺失仅告警空串启动 — 改 `${FL_DATABASE_URL:?required}` fail-fast。
- [P2] .gitlab/ci/quality-test.yml:118 — e2e job `kill -9` 所有占 7200 端口进程，可能误杀
  同机其它服务 — 清理前校验进程 cmdline 属本项目。
- [P2] scripts/edge-function-smoke.mjs:24 — 内网 Supabase 地址与 anon key 硬编码入库 —
  改环境变量注入。
- [P2] scripts/cleanup-probe-tokens.sh:7 — 密码经 curl -d 命令行传递且未 JSON 转义 —
  改 `--data @-` stdin 传入。
- [P2] scripts/dingtalk-notify.mjs:185 — 共享 tmpdir 可预测文件名写请求体（符号链接抢占
  风险）— 改 fs.mkdtemp 或 'wx' flag。
- [P2] scripts/create-deploy-package.js:845,333,194 — `uploadResult.usePassword` 取自不
  存在的返回字段、形参被同名 let 覆盖，属死数据流 — 清理。
- [待确认] scripts/dingtalk-notify.mjs:131 — 临时图片服务绑 0.0.0.0 无鉴权（注释称有意
  设计，存活 30 分钟）— 确认内网边界，必要时改绑内网 IP。
- [待确认] .gitlab/ci/ops.yml:44 — 从 supabase 容器 printenv 读密钥依赖「runner 与
  Supabase 同机」隐含前提 — 作业开头断言此前提。

## 二、AI/媒体服务（[暂缓]；多为结构性重构，需配套测试）

- [P1] packages/drawnix/src/services/model-adapters/types.ts:16 — AdapterContext 无
  signal，adapter 层不可取消（kling/seedance/happyhorse 轮询上限约 90 分钟，取消/卸载后
  仍在跑；fallback-adapter-routes.ts:296 完全未传信号）— 增加 AbortSignal 并透传到
  sendAdapterRequest 与各轮询 sleep。
- [P1] packages/drawnix/src/services/model-adapters/kling-adapter.ts:543（同模式
  flux-adapter.ts:233、mj-image-adapter.ts:134）— 轮询内查询无 try/catch，一次瞬时错误
  毁掉已提交的远程任务 — 对齐 happyhorse-adapter.ts:460-527 的连续错误计数+退避。
- [P1] packages/drawnix/src/services/media-api/image-api.ts:302,375 — 异步图片轮询单次
  !ok 直接 throw — 参照 video-api.ts:204-222 增加容错退避。
- [P1] packages/drawnix/src/mcp/tools/canvas-insertion.ts:348 与
  services/canvas-operations/canvas-insertion.ts:356 约 500 行逐同名重复（另：mcp/tools/
  long-video-generation.ts 与 services/canvas-operations/long-video.ts 整文件重复、两份
  ai-analyze 高度重复）— 保留 services 层实现，mcp 工具薄委托。
- [P1] packages/drawnix/src/services/canvas-operations/canvas-board-ref.ts:3 — board 引用
  存在 3 个独立模块级单例，宿主需手工 set 5 处（AIInputBar.tsx:641-646），漏设即「画布未
  初始化」— 合并为单一 board-ref 模块。
- [P1] packages/drawnix/src/mcp/tools/long-video-generation.ts:298（同
  services/canvas-operations/long-video.ts:282）— totalDuration/segmentDuration 无上下界
  （0→Infinity、负数→NaN、可生成数百段）— 校验 1≤segmentDuration≤30 及 totalDuration
  上限后再计算。
- [P2] packages/drawnix/src/services/media-executor/task-storage-writer.ts:214 —
  updateStatus/updateProgress/completeTask 非事务读改写，并发时旧快照可覆盖 completed+result
  （任务卡 processing）— 状态迁移改单事务或只 put 增量字段。
- [P2] packages/drawnix/src/services/media-executor/llm-api-logger.ts:202 — complete/fail
  只查 50 条 memoryLogs，超出后 IndexedDB 日志永久 pending — 按 id 直接更新 IndexedDB。
- [P2] packages/drawnix/src/services/media-api/video-api.ts:191 — pollVideoUntilComplete
  无总次数/总时长上限（对照 fallback-utils.ts:96 有 120 次上限）。
- [P2] packages/drawnix/src/services/model-adapters/seedance-adapter.ts:89 — urlToBlob 裸
  fetch 不查 response.ok（404 错误页会被当图片塞进 FormData）且绕过 providerTransport。
- [P2] packages/drawnix/src/services/model-adapters/kling-adapter.ts:520 —
  `...(adapterParams||{})` 整体透传上游（黑名单式剔除易漏）— 改显式白名单。
- [P2] packages/drawnix/src/services/workflow-engine/engine.ts:269 — continueOnError=false
  时 Promise.all 立即 reject，兄弟步骤继续跑且晚于 workflow.failed 落库 — abort 其余或
  allSettled 收敛。
- [P2] packages/drawnix/src/services/workflow-engine/engine.ts:579 — executeMainThreadTool
  不传 signal，取消工作流无法中断画布类工具。
- [P2] packages/drawnix/src/services/media-executor/fallback-executor.ts:1393 — getConfig
  每次生成重复 3 次路由解析+全量绑定推断（每图/每视频执行两遍）— 按 modelRef 请求内缓存。
- [P2] packages/drawnix/src/mcp/tools/image-generation.ts:463（video/audio/grid 同）— 参数
  仅校验 prompt，referenceImages 传字符串时下游 .map 崩溃 — execute 入口加最小运行时守卫
  （参照 text-generation.ts:48）。
- [P2] packages/drawnix/src/services/model-adapters/gpt-image-adapter.ts:280、
  happyhorse-adapter.ts:219 — 参考图串行下载 — Promise.all 并行。
- [P2] packages/drawnix/src/services/media-executor/fallback-executor.ts:775 — generateVideo
  pollingTasks 命中时 else 分支为空，重复调用静默无回调 — 抛错或复用既有轮询。
- [P2] packages/drawnix/src/mcp/registry.ts:129 — executeTools 无并发上限 Promise.all —
  加 worker-pool 并发上限。
- [P2] packages/drawnix/src/services/media-executor/fallback-adapter-routes.ts:315 —
  `void updateRemoteId` 无 catch，IDB 写失败静默（刷新后无法恢复轮询）— 补 .catch(warn)。
- [待确认] packages/drawnix/src/mcp/tools/svg-tool.ts:119-135 + utils/svg-utils.ts
  normalizeSvg — 不剥离 script/on*，靠 `<img>` 渲染兜底；若未来内联 SVG 渲染即存储型 XSS —
  预留 sanitize。
- [待确认] packages/drawnix/src/services/provider-transport.ts:179-198 — authType='query'
  把 key 拼进 URL（Gemini 约定），会进代理访问日志 — 确认托管代理端日志策略。

## 三、前端与 SW（[暂缓]；需产品/UX 决策或较大改动）

- [P2] apps/web/src/supabase/supabase-client.ts:12,16 — 生产构建缺 VITE_SUPABASE_URL 时
  静默回退硬编码内网 IP + 硬编码 anon JWT — 构建期校验 env 必填并移除回退（需先确认所有
  构建路径都注入 env）。
- [P2] apps/web/src/sw/index.ts:631 — loadConsoleLogsFromDB 7 天窗口全量入内存（无上限）
  — 游标读取加 limit/分页（调试面板 UX 需确认展示上限）。
- [P2] apps/web/src/sw/task-queue/llm-api-logger.ts:250 — 分页接口先全量加载（最多 1000
  条 ×128KB body）再切片 — 改 IDBKeyRange+cursor 或 compact 投影。
- [P2] apps/web/src/crash-logger.ts:962,705,740 — FPS rAF 循环永不停止；与
  utils/sw-console-capture.ts:318,327 对 window error/unhandledrejection 双重监听重复上报
  — FPS 降频 + 错误上报收敛单入口（涉及遥测归属）。
- [P2] apps/web/src/utils/permissions-policy-fix.ts:15 — 全局替换 add/removeEventListener
  猴补，静默吞掉第三方 unload 注册 — 改为只提示并透传注册（需回归验证 bfcache 目的）。
- [P2] packages/utils/src/format 与 function/format 两套格式化工具重复
  （formatSize/formatFileSize、formatDurationMs/formatDuration、truncate/truncateText）—
  输出格式不同，合并需 API 兼容决策；单位索引钳制已修。
- [P2] packages/utils/src/workflow/parser.ts parseWorkflowResponse — 同一响应重复完整解析
  4+ 次 — 解析一次后分发（需性能基准与回归）。
- [P2] packages/react-board/src/wrapper.tsx:355,363,587,597 — summarizeViewport/
  getViewportDomSnapshot/formatDebugPayload 死代码、logViewportDebug 空实现 — 删除或恢复。
- [P2] packages/react-board/src/wrapper.tsx:151,162 — `op.type === 'set_selection'` 魔法
  字符串 — 改 PlaitOperation 类型化谓词（同文件 100-114 已有正确写法）。
- [P2] packages/utils/src/workflow/utils.ts:30 — updateStepStatus 6 个位置参数 — 收敛为
  options 对象（API 变更，需同步调用方）。
- [P2] packages/react-text/src/text.tsx:222 — Leaf 14 处 `(leaf as any)['font-...']` —
  改用 custom-types.ts 的 ExtendedCustomText。
- [待确认] packages/utils/src/crypto/aes-gcm.ts:193 — encrypt 失败静默降级可逆 Base64
  （OPENTU_FB: 前缀）— 是否提供严格模式（失败抛错）需确认调用方容忍度。
- [待确认] packages/utils/src/logger/index.ts:8 — 「框架无关」包直接读 import.meta.env.DEV
  （Vite 专属）— 确认是否存在非 Vite 消费方。
- [待确认] packages/utils/src/media/image.ts:233 — compressImageWithQuality 恒输出 jpeg，
  透明 PNG 变黑底 — 按源类型选输出格式（需产品确认）。
- [待确认] packages/utils/src/security/index.ts:66 — SENSITIVE_KEYS 含裸 'key' 且子串
  includes 匹配，keyword/keyCode 等被误脱敏；改等值/词边界会造成 'privatekey' 漏脱敏，
  需定匹配规则（现状偏保守安全侧，暂保留）。

## 四、同步引擎（[暂缓/待确认]；涉及云端存量数据与同步语义）

- [P1] packages/drawnix/src/contexts/SupabaseSyncContext.tsx:114-138 — 冲突元素级合并结果
  被整体丢弃（void applyRemoteEntities 不等待，随后按 local/remote 原始实体覆盖）→ 冲突
  每个同步周期复发 — resolveConflict 返回合并实体并由引擎 await 上传/应用。
- [P1] packages/drawnix/src/services/supabase-sync/apply-remote.ts:138-151 — chat_session
  下载用 createSession() 生成新本地 id（丢 entity_id），云端原会话被打墓碑，多设备反复
  删除/复制 — 按 entity_id 幂等写入。**[待确认]**：存量用户云端已打墓碑的会话如何恢复。
- [P1] packages/drawnix/src/services/supabase-sync/local-collector.ts:101,191,199,207,305 —
  workspace_state/kb_tag/kb_note_tag/kb_note_image/settings 的 updatedAt 收集时伪造为
  Date.now()，对端一改即必判 conflict（默认 local 胜，其他设备改动静默丢失）— 读真实
  updatedAt 或按内容稳定派生。
- [P1] packages/drawnix/src/services/task-supabase-archive/service.ts:405,564 — 两个
  fire-and-forget 归档各自整列覆盖 response_file_paths，并发后写者抹掉先写者 — 读-合并-写
  或拆列。**[待确认]**：该列是否还有 SW 端/ai-proxy 旧写入方，合并策略需统一约定。
- [P2] packages/drawnix/src/services/supabase-sync/checksum.ts:14 — 实体 checksum 32 位
  （实为 Java hashCode），数千实体生日碰撞百分位级，碰撞即漏同步 — 换 SHA-256。
  **[待确认]**：与云端存量 checksum 不兼容，首次同步触发一轮全量重传是否可接受。
- [P2] packages/drawnix/src/services/supabase-sync/media-sync-adapter.ts:270-354 — 与
  media-sync.ts 整段复制粘贴（resolveUsername/sanitizeUsername/guessType/sha256Hex）—
  导出复用。
- [P2] packages/drawnix/src/services/supabase-sync/apply-remote.ts:298-315 —
  stripSensitiveKeys 仅过滤顶层 key（嵌套 apiKey 不剥离，仅靠上传端递归脱敏兜底）— 复用
  local-collector 的 sanitizeObject 递归过滤。
- [P2] packages/drawnix/src/services/tracking/tracking-batch-service.ts:164 —
  flushOnUnload 注释称 sendBeacon 实为异步 fetch，关页事件大概率丢失 — 真正用
  sendBeacon/keepalive；同文件 :84 失败 requeue 后不重启定时器且 TrackingStorageService
  未接线（刷新丢缓存）。
- [P2] packages/drawnix/src/services/tracking/tracking-service.ts:395,438 — destroy 不移除
  beforeunload/hover/focus 监听（反复 init/destroy 泄漏）— 保存引用成对移除。
- [P2] packages/drawnix/src/services/tracking/tracking-utils.ts:16 — globalDebounceMap 按
  事件名无界增长 — 加 LRU/过期清理。
- [P2] packages/drawnix/src/services/task-supabase-archive/service.ts:108,198,489 — 归档
  诊断 console.warn 打印文件名/URL 前缀等用户数据 — 降级 dev-only 或接入统一日志并脱敏。
- [P2] packages/drawnix/src/services/agent/agent-executor.ts:448-515 — while 循环两分支
  首轮全部退出，maxIterations 实际无效，死循环结构误导 — 删除循环或实现真正多轮工具回填。

## 五、边缘函数（[待确认]；取决于网关与部署边界）

- [P0] supabase/functions/dashboard-stats/index.ts:73 — /overview 无鉴权（service_role 绕
  RLS 全量公开员工姓名/OA 账号/user_id），是 newapi-key IDOR 的 user_id 来源 — 加管理员
  判定或网关层访问控制。**前提**：确认自建 Kong 是否启用 verify_jwt/网络限制。
- [P1] supabase/functions/dashboard-stats/index.ts:105 — /push-report 无鉴权，可借公司
  钉钉机器人发任意 markdown + 向 Gitee 公开仓库传图 — 加鉴权或共享密钥。
- [P1] supabase/functions/check-email/core.ts:63、check-register/index.ts:42 — 无鉴权无
  限流的邮箱注册/员工资格枚举 oracle — 加限流/验证码或并入注册流程。
- [P1] supabase/functions/newapi-key/core.ts:426,441,470 — new-api 平台密码明文写入
  user_profiles.newapi_password（RLS 下用户自身可读）— 服务端持有随机凭据或对称加密。
- [P2] supabase/functions/newapi-key/core.ts:364 — getOrCreateApiKey 无并发防护，同用户
  并发会留孤儿平台令牌 — userId 粒度加锁。
- [P2] supabase/functions/ai-proxy/core.ts:34 等 — CORS `Access-Control-Allow-Origin: '*'`
  （dashboard-stats、feedbackland-sso 同）— 收敛到已知前端 origin。
- [P2] supabase/functions/dashboard-stats/core.ts:16 — 硬编码 anon key 兜底内嵌页面 —
  移除，env 缺失直接报错（需确认部署保证）。
- [P2] supabase/functions/dashboard-stats/core.ts:377 — countCompletedSince 失败返回 0 使
  周报口径失真（已加日志），根治需返回 null + 页面标注「数据不可用」（UI 变更）。

## 六、其他待办（一次性动作）

- **secret.md 善后**（评审 P0 的收尾）：① 用 `git filter-repo`/BFG 清洗历史中的
  secret.md；② **轮换该文件中的 Supabase 凭据**（文件已下架但历史与克隆仍在）。
- e2e 基线：cloud-sync-canvas-materials.spec.ts 增量同步用例在 2312 失败暴露的时序脆弱性
  （同步前未等 IndexedDB 落盘）已由 flush 修复；建议同类用例统一走「同步前 flush」约定。
- packages/drawnix/src/components/ttd-dialog/ai-video-generation.tsx.tmp — 遗留 .tmp 死
  文件，建议删除以免误导后续审计。
- constants.ts:62 FEEDBACKLAND_URL 内网 http IP 硬编码进客户端 bundle — 部署约定，若调整
  网络方案需同步改。
