# Tasks: add-smart-cutout

## 0. M0 PoC（方案定档，半天 + gated 审批等待）

> 落地记录（2026-10-08）：SAM3 gated 申请被 Meta 地区过滤拒绝（sam3/sam3.1 双拒，
> HF 被拒后无重申请入口），按方案决策树切换 SAM 2.1（无 gate 直链下载）。点提示
> API 与 SAM3 同构（SAM3InteractiveImagePredictor ↔ SAM2ImagePredictor），HTTP
> 契约不变。GPU fp32 定档（无需 bf16）：编码 30–336ms、单点 60–101ms、IoU 0.996、
> 显存峰值 1.4GB；CPU 回退档编码 3.8–6.5s。LICENSE 已归档于
> /home/mdc/codes/segment-server/LICENSE-sam3 与 vendor/sam2/LICENSE。

- [x] 0.1 用户在 HuggingFace 提交 facebook/sam3 访问申请（gated）→ 被拒，走决策树
- [x] 0.2 获取 sam 源码（gh-proxy 通道成功），vendor 到 services/segment-server/vendor/sam2
- [x] 0.3 下载 checkpoint 到服务器 /home/mdc/codes/segment-server/models/（898MB 直链）
- [x] 0.4 单脚本实测：GPU/CPU 两档 encode/decode 延迟与显存峰值；核实点提示 API；归档 LICENSE
- [x] 0.5 按 Performance Budget 定档 device 配置（GPU fp32 + OOM 自动 CPU）

## 1. M1 sam3-server 服务

- [x] 1.1 services/segment-server/：FastAPI 应用（/encode /segment /health、会话 LRU32+TTL10min、encode 信号量、显存软限与 CPU 降级、日志）
- [x] 1.2 pytest：契约校验 / 会话淘汰 / mask 编码 / OOM 降级路径
- [x] 1.3 Dockerfile（pytorch cu128 基底）+ scripts/deploy-sam3-server.sh（构建、入 supabase_default 网络、不发布端口、--memory 12g、restart unless-stopped）
- [x] 1.4 服务器上线并 curl /health 验证（含 GPU/CPU 两档各验一次）

## 2. M2 edge function image-segmentation

- [x] 2.1 supabase/functions/image-segmentation/：index.ts + core.ts（JWT 鉴权复用 asset-vector-search 模式、action 白名单、参数校验、超时、错误包装）
- [x] 2.2 core.test.ts（node --test）：401 / 校验 / 透传 / 超时 / 上游 5xx
- [x] 2.3 部署（scp + docker restart supabase-edge-functions）并 curl 冒烟（真实 JWT 走通 encode+segment）

## 3. M3 前端

- [x] 3.1 packages/drawnix/src/services/segmentation-service.ts：encode/segment 封装 + 错误分级；vitest 单测（mock functions.invoke）
- [x] 3.2 cutout-utils.ts：mask 上采样、羽化（0–3px）、destination-in 合成、跨源重载失败分支；vitest 纯函数单测
- [x] 3.3 EditMode 增加 'cutout'；ImageEditorCore 模式按钮组加"抠图"；CutoutPanel.tsx（正/负点交互、点撤销/清空、mask 覆盖层、encode loading、棋盘格预览、确认→onInsert/onSave dataURL 链路）
- [x] 3.4 E2E（apps/web-e2e，服务 mock）：进入编辑器抠图 tab → 模拟点击 → 遮罩出现 → 确认 → 画布新元素断言
- [x] 3.5 服务不可用与降级：服务不可用时面板给出明确提示并可退出；HTTP LAN 下全程可用（无 secure-context API）

## 4. M4 收尾与发布

- [x] 4.1 文档：apps/web/public/user-manual 新增"智能抠图"；docs/new-feature-plan-100.md #41 标注底层能力已落地；CHANGELOG.md
- [ ] 4.2 本地全量测试（进行中）（pnpm check + vitest + node --test + e2e）全绿
- [ ] 4.3 LAN HTTP 过目（非 localhost 地址，如 http://10.37.80.175:7200）：真服务抠图全流程
- [ ] 4.4 推送 main，监控流水线全绿；生产部署待用户手动触发（部署红线）
