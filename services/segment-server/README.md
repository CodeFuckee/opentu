# segment-server

opentu 智能抠图（#41）的推理服务：FastAPI + SAM 2.1 hiera-large，独立 docker 容器，
仅 `supabase_default` 网内可达（不发布端口），由 edge function
`image-segmentation` 做 JWT 鉴权后转发。

## 架构

```
浏览器 functions.invoke('image-segmentation')   ← 现有 supabase origin,零 CSP 改动
  └─ supabase-edge-functions (JWT 校验,复用 asset-vector-search 模式)
       └─ http://segment-server:8300
            ├─ POST /encode    {imageB64}            → {sessionId,width,height,device,encodeMs}
            ├─ POST /segment   {sessionId,points,labels,box?} → {maskPngB64,score,...}
            └─ GET  /health                          → {status,model,device,sessions}
```

- **引擎模型无关**：`app/engine.py` 的 `CutoutEngine` 协议下当前实现为 SAM 2.1；
  SAM3 的 gated 申请被 Meta 地区过滤拒绝（2026-10-08，HF 被拒后无重申请入口），
  日后拿到合规授权可在同协议下热替换（sam2 与 sam3 的点提示 API 同构）。
- **GPU fp32 + CPU 自动降级**：显存软限 `SEG_MEM_FRACTION`（默认 0.25，实测峰值
  1.4GB）；CUDA OOM 时模型就地迁 CPU 并 `generation+1`，旧会话 /segment 返回 410
  触发前端自动重编码。
- **会话**：LRU 32 + TTL 10min（`SEG_MAX_SESSIONS`/`SEG_SESSION_TTL_S`），
  编码全局串行（`SEG_ENCODE_CONCURRENCY=1`）保护共享单卡。

## 本地测试（无需 torch/GPU）

```bash
cd services/segment-server
pip install fastapi uvicorn httpx pillow numpy pytest
python -m pytest tests/ -q    # 20 例:契约校验/LRU+TTL/掩码编码/410 代数/降级路径
```

## 部署（宿主机 10.37.80.25）

```bash
# 仓库源码先同步到 /home/mdc/codes/segment-server/repo/services/
ssh mdc@10.37.80.25 'bash -s' < scripts/deploy-segment-server.sh
# 全链路冒烟(真 JWT → edge function → GPU)
ssh mdc@10.37.80.25 'bash -s' < scripts/smoke-image-segmentation.sh
```

镜像基底复用宿主机现成的 `davidamacey/opentranscribe-backend:v0.5.0`
（torch 2.11+cu128；RTX 5080/Blackwell sm_120 必须 cu128 轮子）。三个环境坑
（M0 实测）：

1. `pip install -e` 的 build isolation 会从 pypi.org 直连拉 torch 构建依赖挂死
   ——本镜像改为 `PYTHONPATH=/app/vendor/sam2` 直连源码 import；
2. torchvision 必须从 `download.pytorch.org/whl/cu128` 安装，PyPI 轮子与 +cu128
   定制 torch ABI 失配（`operator torchvision::nms does not exist`）；
3. pip 走 aliyun 源最快（tuna 索引可达但下载会挂）；GitHub 源码经 gh-proxy 获取
   后 vendor 进本目录（`vendor/sam2`，含 LICENSE）。

权重 `sam2.1_hiera_large.pt`（898MB）从 fbaipublicfiles 直链下载（无 gate），
部署脚本缺失时自动下载到 `/home/mdc/codes/segment-server/models/` 只读挂载。

## 性能（M0 基准 + 线上冒烟，RTX 5080 / 1024px）

| 指标 | GPU fp32 | CPU 32 线程 |
| --- | --- | --- |
| /encode | 30–336ms | 3.8–6.5s |
| /segment 单点 | 60–101ms | 85–135ms |
| 掩码 IoU（合成图） | 0.996 | 0.996 |
| 显存峰值 | 1.4GB | — |
