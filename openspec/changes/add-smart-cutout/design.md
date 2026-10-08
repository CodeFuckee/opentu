# 智能抠图（服务端 SAM3）技术方案

> 状态：实现中（M0–M3 已落地，M4 收尾）
> 调研日期：2026-10-08（服务器/GPU/HF 仓库均为当日实测）
>
> **落地变更（2026-10-08）**：SAM3 gated 申请被 Meta 地区过滤拒绝（sam3/sam3.1
> 双拒；HF 被拒后无重申请入口，用户已确认），按 D-备选切换 **SAM 2.1
> hiera-large**（898MB 无 gate 直链）。点提示 API 与 SAM3 同构，HTTP 契约与
> 前端零改动；服务与容器更名为模型无关的 `segment-server`。GPU fp32 定档
> （显存峰值实测 1.4GB，无需 bf16）；基底镜像复用宿主机现成 torch 2.11+cu128。
> 详见 services/segment-server/README.md 与 CHANGELOG。

## Context

- 用户诉求："点击抠图/智能选中素材"——在图上点几个点，把目标物体抠成透明底素材，插回画布。
- 对应功能计划 #41（选中元素 AI 操作菜单，P0）的"抠图"子能力；v1 入口放在图片编辑器，#41 的画布右键菜单壳留待后续。
- 指定技术路线：服务端跑 [facebookresearch/sam3](https://github.com/facebookresearch/sam3)（原 segment-anything 已停止更新，SAM 3 为其官方后继，支持点/框/掩码/文本提示）。

### 服务器现状（2026-10-08 实测，10.37.80.25）

| 项 | 现状 | 影响 |
|---|---|---|
| GPU | RTX 5080 16GB，**已用 9.77GB**（funasr 6.6GB + diar-server 0.9GB + 其他 ~2.2GB），剩约 6.5GB | SAM3 bf16 可行但紧张，需显存上限 + CPU 回退 |
| CPU / 内存 | 32 核，可用内存 126GB | CPU 回退路径完全可用 |
| 磁盘 | 431GB 可用 | 镜像 + 模型文件无压力 |
| CUDA Driver | 13.2（Blackwell sm_120） | **必须用 cu128 及以上的 torch 构建**（torch ≥ 2.7 cu128） |
| 网络 | hf-mirror.com 可达（实测）；raw.githubusercontent.com 不可达 | 模型走 hf-mirror；sam3 源码获取需备选通道 |
| Docker | 29.1.3；supabase 全家桶在 `supabase_default` bridge 网络 | 新容器入网即可被 edge functions 容器按名访问 |

### 模型获取的关键事实

- [facebook/sam3](https://huggingface.co/facebook/sam3) 与 [facebook/sam3.1](https://huggingface.co/facebook/sam3.1) 均为 **gated（manual 审批）** 仓库：必须先用 HuggingFace 账号在网页上提交访问申请（填表接受 Meta SAM License，通常数小时到一天自动批），拿到资格后带 `HF_TOKEN` 从 hf-mirror 下载。
- checkpoint 体量：sam3.1 仓库单文件 `sam3.1_multiplex.pt` ≈ 6.5GB；sam3 仓库含 `sam3.pt` + `model.safetensors`（transformers 格式）。fp32 参数约 1.6B 量级。
- 许可：Meta 自定义 SAM License（基于 Apache 2.0 修改，`license: other`），gated 申请提交即视为接受条款；内部工具使用预期合规，M0 归档 LICENSE 全文备查。
- **降级备选**：SAM 2.1 checkpoints（`facebook/sam2-hiera-large` 等，非 gated、可直接下载）点提示抠图能力同样完整，仅缺 SAM3 的文本提示能力。本方案 API 按模型无关设计，后端可无痛切换。

## Goals / Non-Goals

**Goals（v1）**
- 图片编辑器内：点击正/负点（可选框选）实时 refine mask，确认后得到透明底 PNG，走现有插图链路进画布。
- 服务端推理：GPU bf16 优先、显存不足自动回退 CPU；一次编码会话内多次点击只跑轻量解码。
- 全链路在 HTTP 明文内网可用（部署红线），零 CSP 改动、零新增前端依赖。

**Non-Goals（v1 不做，登记为后续）**
- 文本提示抠图（"把沙发抠出来"）——SAM3 已支持（`set_text_prompt`），服务端契约预留，UI 留 v2。
- 画布上直接右键 AI 菜单（#41 的完整交互壳）。
- 抠图结果存个人素材库并注册 CLIP 向量（接 #61 以图搜图）。
- 绿幕/颜色键控、alpha matting 级别的边缘精修（仅提供轻量羽化）。

## Decisions

### D1 架构：独立 Python 容器 + edge function 代理（而非直连/而非塞进 Deno）

```
浏览器 (HTTP LAN, 现有页面)
  └─ supabase.functions.invoke('image-segmentation')      ← 现有 supabase origin（8021），自动带用户 JWT
       └─ supabase-edge-functions (Deno)
            ├─ JWT 鉴权（复用 asset-vector-search/core.ts 的校验模式）
            └─ fetch http://sam3-server:8300               ← supabase_default 容器网络，流量不出宿主机
                 └─ sam3-server（FastAPI + torch + SAM3）
                      ├─ POST /encode    图片 → 推理会话（LRU 32 / TTL 10min）
                      ├─ POST /segment  点/框 → mask PNG(base64)
                      └─ GET  /health   {model, device, sessions}
```

- 备选 A（前端直连 sam3-server 端口）：要在 CSP connect-src 三处加新 origin、自建鉴权与 CORS——放弃。
- 备选 B（在 Deno edge function 里跑推理）：Deno 无 PyTorch/权重加载不现实——放弃。
- 备选 C（浏览器端 WASM 跑 MobileSAM/SlimSAM）：内网 HTTP 无 WebGPU（secure-context 限制），WASM CPU 每图数秒且占用户机器——与"服务端跑 SAM3"的既定方向不符，登记为未来离线模式备选。
- 代价：图片与 mask 经过 edge function 中转（≤1024px JPEG ≈ 100–400KB，PNG mask ≈ 几十 KB，自托管 edge runtime 默认 body 限额内无压力）。

### D2 推理服务：两阶段会话（一次编码、多次点击）

SAM 系模型天然两段式：image encoder 重（一次）、prompt decoder 轻（每次点击）。服务端把 `processor.set_image(image)` 产生的 inference_state 存入会话池：

- `session_id = uuid4`，LRU 容量 32、TTL 10 分钟（编辑一张图的交互窗口绰绰有余）；
- GPU 模式下显存软限（`torch.cuda.set_per_process_memory_fraction ≈ 0.28`，约 4.5GB），编码 OOM → 自动降 CPU 重载，`/health` 与响应字段 `device` 如实上报；
- 并发治理：encode 全局串行（asyncio 信号量=1，GPU 只有一块且与他人共享），decode 并发 ≤2；
- 图片不落盘：请求内存字节直接解码，会话过期即释放；日志只记耗时/device/会话数。

模型加载用官方 API（`build_sam3_image_model()` + `Sam3Processor`，README 已核实）；点提示的确切方法名（SAM2 风格的 add_points/predict）在 M0 PoC 里对照仓库源码核实——本方案的 HTTP 契约不依赖其内部 API 形态。

### D3 服务端 HTTP 契约（模型无关，可平替 SAM2/SlimSAM）

| 端点 | 请求 | 响应 | 说明 |
|---|---|---|---|
| POST /encode | `{imageB64}`（JPEG/PNG，长边 ≤1024，服务端二次校验并缩放） | `{sessionId, width, height, device, encodeMs}` | 一次编码；前端展示"分析图片中…" |
| POST /segment | `{sessionId, points:[[x,y],…], labels:[1\|0,…], box?}` | `{maskPngB64, score, maskWidth, maskHeight, decodeMs}` | 点数 ≤16，坐标为 encode 返回尺寸系下的非负整数 |
| GET /health | — | `{status, model, device, sessions, version}` | 部署验证 + dev-monitor 巡检 |

mask 为二值 PNG（mode L，255=选中），base64 传输；前端上采样到原图分辨率合成。`box`（xyxy）为 v1.1 框选预留，字段先定进契约。

edge function `image-segmentation` 对应三个 action 透传，并做白名单校验（action 枚举、sessionId 为 uuid 格式、点数 ≤16、坐标 0..4096 整数、imageB64 ≤ 8MB）；超时 encode 30s / segment 10s；CORS/JWT/错误包装全部复用 asset-vector-search 模式（不持有 service_role）。

### D4 前端：图片编辑器第三模式 + 合成纯函数

- `EditMode` 增加 `'cutout'`（types.ts 现为 `'crop' | 'filter'`），ImageEditorCore 的模式切换按钮组加"抠图"，新面板 `CutoutPanel.tsx`。
- 交互：左键=正点（绿＋）、右键或 Alt+左键=负点（红－），点标记可撤销/清空；每次点集变化调用 /segment，mask 以半透明覆盖层实时显示；首次进入面板触发 /encode（loading 态"AI 分析图片中…"）。
- 确认抠图 → 棋盘格透明底预览 →「插入画布 / 保存」复用编辑器现有出口：ImageEditorCore 已是 `canvas.toDataURL('image/png')` → `onInsert(dataUrl)/onSave(dataUrl)`（ImageEditorCore.tsx:723 起的既有模式），调用方的上传归档与插图逻辑零改动。
- `cutout-compose.ts` 纯函数（可单测）：原图位图 + mask 上采样 + 可选羽化（0–3px）→ `destination-in` 合成 → PNG dataURL。原图获取走 `resolve-editor-image-source.ts`（已解决虚拟 URL/SW 降级），跨源图 `crossOrigin='anonymous'` 重载（#103 的既有教训）。
- 会话与点集状态在面板内 `useState`/`useRef` 管理，编辑器关闭即丢弃；service 层（`segmentation-service.ts`）只做 invoke 封装 + 错误分级提示（服务不可用/超时/参数错误）。

### D5 部署与发布

- 镜像：`pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime` 基底（自带 sm_120 支持）+ fastapi/uvicorn/pillow + sam3 源码（vendor 进 `services/sam3-server/vendor/`）。sam3 源码获取通道（github 直连不可达）：gh-proxy 类镜像 tarball / 本机代理下载后 scp / gitee 镜像，M0 落实并入库。
- 运行：`docker run --gpus '"device=0"' --memory=12g --restart unless-stopped --name sam3-server --network supabase_default sam3-server`；**不发布端口到 LAN**（安全边界在 edge function 的 JWT）。
- 模型文件：hf-mirror + HF_TOKEN 下载到宿主机卷 `/home/mdc/codes/sam3-server/models/` 挂载进容器（与 edge function scp 部署同一运维模式）。
- edge function 部署：scp + `docker restart supabase-edge-functions`（既有模式）。
- 发布顺序：M0 PoC（含 gated 申请）→ 服务上线 → edge function → 前端（feature flag 无需，面板即功能）→ LAN 过目 → 推送 main。

## Risks / Trade-offs

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| HF gated 审批慢或被拒 | 中 / 阻塞 SAM3 路线 | 尽早提交申请（唯一需要用户人工操作的一步）；被拒则切 SAM 2.1（非 gated），契约不变 |
| GPU 剩余显存不足（bf16 权重 ~3.3GB + 激活，与 funasr 共卡） | 中 / 延迟劣化 | 显存软限 + OOM 自动 CPU（32 核，编码 ~数秒可接受）；PoC 实测定档 |
| funasr 等进程显存波动导致互相 OOM | 低 / 双方抖动 | 我们侧限 4.5GB 且可随时切 CPU；容器 `--memory=12g` 兜底 |
| sam3 点提示 API 与 README 摘要出入 | 低 / 返工 | M0 PoC 第一件事核实 predictor API；transformers 版 Sam3Model 为备选实现路径 |
| CPU 回退时首击延迟高（>5s） | 中 / 体验 | loading 文案明示"首次分析约 x 秒"；会话缓存保证后续点击都快 |
| edge function body 限额 | 低 / 大图失败 | 前端统一压到 1024 长边 JPEG 再上传 |
| Meta SAM License 条款 | 低 / 合规 | gated 申请即接受；M0 归档 LICENSE 全文，内部使用预期合规，如有限制条款上报用户 |
| CI 依赖真服务导致流水线不稳 | 中 / 门禁 | E2E 不直连真服务：UI 流程用服务 mock；真链路验证放 LAN 过目 + 服务端 pytest（见测试策略） |

## Performance Budget（PoC 实测后定稿，超标走决策树）

| 指标 | GPU 目标 | CPU 目标 | 超标决策树 |
|---|---|---|---|
| /encode | ≤2s | ≤8s | GPU→CPU→换 sam2-hiera-large→换 SlimSAM ONNX |
| /segment（每次点击） | ≤300ms | ≤1s | 同上（换轻模型） |
| 显存峰值 | ≤4.5GB | — | 降 memory_fraction→纯 CPU |

## Testing Strategy

- **sam3-server（pytest）**：契约校验（无图/超限坐标/超点数 400）、encode→segment 会话命中与 LRU/TTL 淘汰、mask PNG 编码正确性（小图手工 mask）、显存软限降级路径（mock cuda OOM）。
- **edge function（node --test，仿 asset-vector-search/core.test.ts）**：JWT 缺失 401、action 白名单、参数校验、透传与超时、上游 5xx 包装。
- **前端（vitest）**：`cutout-compose.ts` 纯函数（mask 上采样、羽化、destination-in、跨源图重载失败分支）；`segmentation-service.ts` mock invoke 的错误分级。
- **E2E（apps/web-e2e）**：编辑器抠图 UI 流程（服务层 mock：点选→遮罩出现→确认→插入画布断言元素存在）；真服务链路在 LAN 过目环节人工验证（http://10.37.80.175:7200 及同类地址），不进 CI 门禁。

## Migration Plan

1. M0 PoC：gated 申请（用户）→ 源码/权重落地 → 单脚本实测 GPU/CPU 延迟与显存 → 确认 device 配置（半天 + 审批等待）。
2. M1 sam3-server：服务 + pytest + 镜像构建 + 上线 + /health 验证（1 天）。
3. M2 edge function：core 测试 + 部署 + curl 冒烟（0.5 天）。
4. M3 前端：service/CutoutPanel/合成 + 单测 + E2E（mock）（1.5 天）。
5. M4 收尾：user-manual、计划表 #41 标注、CHANGELOG、本地全量测试、LAN 过目、推送 main、监控流水线全绿（1 天）。

回滚：删容器 + 删 edge function 目录重部署即可，前端面板随版本回滚；无数据库变更、无数据迁移。

## Open Questions（待用户拍板）

1. **HF gated 申请**：需要用户用一个 HuggingFace 账号在 facebook/sam3 页面提交访问申请（唯一人工阻塞项）。若不想申请 → 直接采用 SAM 2.1（非 gated），其余方案不变。
2. **GPU 策略**：默认"GPU bf16（限 4.5GB）+ OOM 自动 CPU"；若担心与 funasr（语音服务）互相挤压，可选纯 CPU 模式（慢但稳）。
3. **v1 范围确认**：入口=图片编辑器第三 tab；文本提示抠图与 #41 右键菜单壳、抠图入库注册向量均为后续版本。
