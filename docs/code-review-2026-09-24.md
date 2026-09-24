# 第八轮全仓库代码评审报告（2026-09-24）

- **方法**：code-review-skill 五维度清单（架构/性能/安全/质量反模式/常见 bug），typescript.md /
  react.md / common-bugs-checklist.md / cross-cutting（error-handling、async-concurrency、xss、
  sql-injection、n-plus-one）逐项检查；subagent 并发派发连续撞 1302 限速，改为主会话直评。
- **与第七轮关系**：本轮为增量深评，基线为第七轮报告提交（c9f731c0）之后的全部代码：
  ① 9 个新提交（405cf73e apiKey 修复、2c809b3e 家居库组图、524dced2 HoverTip、
  c661d76f 方案1 画布公开桶直链、c8605b0a 补字段、8bffa0e8 BuildInfo HoverTip、
  ffdd8a71/5b79c749 CI 门禁、208a7b6e 用户排行、f65a4079 移除密码回写、b6f39a37/4ce1ebf5
  看板月快选）；② 工作区 WIP（dingtalk-notify 图片通道、jzxz 爬虫增强、canvas-helpers 重试、
  植物库爬虫与迁移、ai-outputs 迁移等未跟踪文件）。前七轮已登记项一律不重复，仅勘误。
- **特别说明**：本轮评审期间检测到另一会话在本仓库并行开发（评审中段 6 个新提交落地），
  评审基线随之切换到当前 HEAD；跨会话活跃文件（dingtalk-notify.mjs、jzxz-*-crawler.py、
  canvas-helpers.ts、archive-generated-media.test.ts）只登记不动，避免踩踏。
- **标注**：B = 行为保持（本轮修复或可修）；C = 改变行为/需产品决策，待拍板。
- **处置汇总**：批次 1 修复 4 条（1P1 交付完整性 + 1P1 过时测试 + 2P2）；其余登记待确认。

## 一、P1

- [P1] supabase/migrations/ai_outputs_bucket.sql（未跟踪）— 方案1 主提交（c661d76f）已进
  main，但其依赖的「ai-outputs 公开桶 + RLS 策略」迁移仍只存在于工作区（c8605b0a 已发生过
  一次漏暂存，本次是第二次漏）：生产部署将缺桶，画布/素材 ai-outputs 直链全 404 —
  随本轮批次提交入库（内容已逐行复核：幂等、upsert 需 UPDATE+SELECT 放行的注释与实测
  一致、公开读桶符合方案1 语义）— (B，**批次 1 已修**)
- [P1] apps/web/src/supabase/auth-context.spec.tsx（未跟踪）— 测试对象是已被 f65a4079 删除的
  recordAccountPassword（明文密码回写），实测 3/5 用例对 HEAD 必挂；apps/web vitest
  include `src/**/*.spec.tsx` 会收录它，本地全量测试门禁被此死测试阻塞 — 删除该过时
  spec（f65a4079 已确认该功能从未成功工作且属 P0 明文密码落库，正向断言无重生价值；
  如需回归可另写「登录/注册后不产生 user_profiles 密码 upsert」负向断言）— (B，**批次 1 已修**)

## 二、P2

- [P2] packages/drawnix/src/hooks/useAutoInsertToCanvas.ts:570-580 — 空画布回退
  `resolvedInsertionPointRaw ?? [0, 0]` 之后紧跟 `if (!resolvedInsertionPoint)` 分支：
  永假死代码，内含永不触发的 console.warn（c661d76f 把「静默丢弃」改「回退原点」时的
  残留）— 删除死分支（**批次 1 已修**）
- [P2] packages/drawnix/src/hooks/useImageGenerationAnchorSync.ts:121 — 局部类型
  `public_urls?: string[]` 与运行时/其余三处声明（core.types.ts:303、task-storage-writer
  SWTask、task-storage-reader 均为 `Array<string | undefined>`）漂移：mergeArchiveIntoResult
  与 useAutoInsertToCanvas:647 实际会写入 undefined 项，:129 的 typeof 守卫恰证明作者已知
  运行时可含 undefined — 局部类型改 `Array<string | undefined>`（**批次 1 已修**）
- [P2] scripts/dingtalk-notify.mjs uploadToGitLab（工作区 WIP 新增段）—
  `os.tmpdir()/dingtalk-notify-commit-${Date.now()}.json` 可预测文件名写含 base64 图片的
  请求体，与已登记 P2（:185 同族「共享 tmpdir 可预测文件名」）完全同型的新实例 —
  fs.mkdtemp 或 'wx' flag — (**登记不动**：该文件为并行会话活跃 WIP，随其批次落地时同修)

## 三、待确认（需拍板，本轮不修）

1. **[P2→产品] ai-outputs 公开桶匿名枚举面**：`for select to public using (bucket_id=
   'ai-outputs')` 在 Supabase Storage 语义下同时约束 list 操作——匿名用户可经 storage API
   枚举全桶对象（含他人生成图）。迁移注释「URL 不可猜测」防不住枚举。内网部署风险有限，
   但需明确接受与否；不接受则实测自托管 storage 的 list 语义后加路径前缀约束或改签名 URL
   交付。
2. **[P2] useAutoInsertToCanvas.ts:594-661 归档等待串行**：for..of 逐任务 await，上限 180s/任务，
   多图任务最坏 180s×N 才开始插入。并行化会改变插入顺序（属行为变化），与 GENERATED_
   ARCHIVE_WAIT_MS 取值一并拍板。
3. **[P2] supabase/migrations/user_profiles_add_password.sql 成死文件**：密码回写功能已由
   f65a4079 整体移除，迁移不应入库；若该 alter 曾在生产库执行过，建议择机
   `alter table user_profiles drop column if exists password`。
4. **[P2] test-files/（未跟踪，big_test_data.jpg 等）**：image-upload-consistency.spec 的
   依赖夹具，缺失时用例 test.skip——内网 CI 与本地行为因此不同。入库（仓库变大）与不入库
   （用例在 CI 恒跳过）需拍板；若入库建议压缩到判定阈值附近的最小体积。
5. **[沿用] canvas-helpers.ts selectCenterElement 重试前点击空白处**：创建态工具下可能产生
   退化元素（第七轮§七已登记，本轮复核仍在，维持原判）。
6. **[沿用] image-upload-consistency.spec.ts**：E2E-IMG-09/11/12/13 把「>25MB 无校验」固化
   为断言 + fixme E2E-IMG-14（第七轮§七已登记，维持原判）。
7. **[记录] 看板 MONTH_OPTIONS 硬编码 ['2026-09','2026-08']**：用户拍板的数据口径（仅两月），
   非缺陷；11 月起需手动扩展，届时若遗忘看板月选不再增长。
8. **[记录] c661d76f 新增常驻生产 console.log**（[AutoInsert][诊断] 全路径、[BuildInfo] 模块级）：
   系用户要求的排查期诊断，问题收敛后建议降 dev-only 或采样。

## 四、复核通过（本轮正面结论）

- **勘误（本轮过程记录）**：评审中段曾对工作区 WIP 版 service.ts 的
  resolveGeneratedMediaPublicUrl 记「注释称等待归档、实际空 taskId 永不归档」一条 P2；
  核对 c661d76f 提交终稿发现该函数已重写（未命中仅等待 pendingList 在途归档、注释如实），
  该条**不成立，撤销**。教训：并行会话场景下所有发现以 HEAD 终稿二次核实为准。

- **405cf73e（apiKey 四路扩散修复）**：攻击者视角复核通过——TRUSTED_TEMPLATE_ORIGINS 用
  `new URL(url).origin` 精确匹配，子域（evil.vercel.ddaiai.com）、后缀贴靠
  （vercel.ddaiai.com.evil.com）、端口、大小写、fragment 夹带全部无法绕过；`#apiKey=/
  #settings=` hash 优先读取、读后 query+hash 一并清除；事件去 detail 与唯一消费方行为
  兼容；6 例单测覆盖到位。第七轮待确认#1 修复质量确认。
- **f65a4079 销项**：第七轮待确认#2（P0 明文密码回写）登录/注册两路彻底移除，工作区
  spec 为遗留物（见 P1-2）。
- **c661d76f（方案1 画布公开桶直链）**：三插入路径（hook flush / media-result-handler /
  SW 消息）经 pendingByUrls/pendingByTask 双键去重，不双重上传；insertImageFromUrl 最底层
  收敛点对虚拟路径/data URL/未注册外部 URL 均快速放行（空 taskId 入口即跳过，无每次插入
  180s 的性能回退）；空画布静默丢弃改回退原点插入；completeTask 收敛点动态 import 规避
  循环依赖、SW 无配置模式静默 no-op 与设计一致。
- **208a7b6e / b6f39a37 / 4ce1ebf5（看板排行/月快选/口径）**：页面渲染 esc() 转义齐、
  数组渲染避同名覆盖、is_admin 门禁沿用、TDD 断言真实（后端 171 全过）。
- **2c809b3e（家居库组图）**：useEffect 复位/useMemo 依赖/回调依赖数组完整；视图组 URL 均
  React 文本渲染无注入面；glb 链接为拼接构造非原始 DB 值，无 javascript: 注入路径；
  check-hover-usage 通过。
- **jzxz_plant_materials.sql + jzxz-plant-crawler.py**（工作区 WIP）：glb_attempts「建表即带、
  ≥3 不再重试」直接吸取家居库 P1 教训；RLS 登录可读/service_role 写、公开桶直链与家居库
  同构，设计无误。
- **5b79c749 / ffdd8a71（CI 门禁）**：quality 堆上限与 lint 修复恢复门禁，方向正确。

## 五、整体印象（第八轮增量）

1. 增量代码质量延续第七轮趋势：新提交全部带 TDD 或既有测试同步更新，看板后端
   core.test.ts 23→25 例，方案1 带 E2E 与 archive 单测同步加固。
2. 唯二的 P1 都是「交付完整性」而非代码缺陷（迁移文件漏提交、删除功能后的遗留测试），
   印证第七轮印象 #4：配置/产物与真实接线之间缺乏一致性检查——建议 CI 加一步
   「migrations 目录无未跟踪 .sql」「无引用已删符号的 spec」类廉价巡检。
3. 跨会话并行开发场景下，工作区 WIP 与 main 的边界开始模糊（本轮评审中段基线漂移一次），
   建议并行会话约定各自文件清单或在 WIP 文件头加标记。
