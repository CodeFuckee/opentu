#!/usr/bin/env python3
"""M0 PoC 基准：SAM3 图片交互式点提示抠图（opentu 智能抠图）。

在合成测试图上量化三种推理策略的延迟、显存与掩码质量：
  fp32-gpu : fp32 权重上 GPU（共享 16GB 卡，可能 OOM）
  bf16-gpu : set_default_dtype(bfloat16) 整模型 bf16 上 GPU
  cpu      : fp32 CPU（32 线程）

用法（容器内，/work = /home/mdc/codes/sam3-server 挂载）：
  PYTHONPATH=/work/src/sam3 python bench_poc.py --strategy bf16-gpu
输出 JSON 写 stdout 与 ./bench-<strategy>.json。
"""
import argparse
import json
import sys
import time
import traceback


def make_test_image():
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1024, 768), (245, 245, 245))
    d = ImageDraw.Draw(img)
    d.rectangle([200, 200, 500, 500], fill=(60, 120, 220))  # 目标 A（矩形）
    d.ellipse([620, 220, 780, 380], fill=(220, 80, 80))  # 干扰 B（圆）
    return img


def iou(m1, m2):
    union = (m1 | m2).sum()
    return float((m1 & m2).sum() / union) if union else 0.0


def run(args):
    import numpy as np
    import torch

    out = {"strategy": args.strategy, "engine": args.engine, "torch": torch.__version__}
    if args.strategy == "cpu":
        device = "cpu"
        torch.set_num_threads(32)
    else:
        assert torch.cuda.is_available(), "CUDA 不可用"
        torch.cuda.set_per_process_memory_fraction(args.fraction, 0)
        free, total = torch.cuda.mem_get_info()
        out["vram_free_before_gb"] = round(free / 2**30, 2)
        out["vram_total_gb"] = round(total / 2**30, 2)
        device = "cuda"
        if args.strategy == "bf16-gpu":
            torch.set_default_dtype(torch.bfloat16)

    if args.engine == "sam3":
        from sam3.model_builder import build_sam3_image_model

        t0 = time.perf_counter()
        model = build_sam3_image_model(
            checkpoint_path=None if args.ckpt == "none" else args.ckpt,
            load_from_HF=False,
            device=device,
            enable_inst_interactivity=True,
        )
        out["load_s"] = round(time.perf_counter() - t0, 2)
        predictor = model.inst_predictor
    else:
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        t0 = time.perf_counter()
        model = build_sam2(
            "configs/sam2.1/sam2.1_hiera_l.yaml",
            args.ckpt,
            device=device,
        )
        predictor = SAM2ImagePredictor(model)
        out["load_s"] = round(time.perf_counter() - t0, 2)

    if args.strategy == "bf16-gpu":
        out["param_dtypes"] = sorted({str(p.dtype) for p in predictor.model.parameters()})
    img = make_test_image()

    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        predictor.set_image(img)
        if device == "cuda":
            torch.cuda.synchronize()
        times.append((time.perf_counter() - t0) * 1000)
    out["set_image_ms"] = [round(t) for t in times]

    def timed_predict(**kw):
        t0 = time.perf_counter()
        masks, scores, _low = predictor.predict(**kw)
        if device == "cuda":
            torch.cuda.synchronize()
        return (time.perf_counter() - t0) * 1000, masks, scores

    # 首次点击：A 矩形中心，multimask
    ms, masks, scores = timed_predict(
        point_coords=np.array([[350, 350]]),
        point_labels=np.array([1]),
        multimask_output=True,
    )
    out["predict_first_ms"] = round(ms)
    mask = masks[int(np.argmax(scores))] > 0
    gt_a = np.zeros((768, 1024), bool)
    gt_a[200:501, 200:501] = True
    out["iou_first"] = round(iou(mask, gt_a), 4)

    # 细化：B 圆心正点 + A 中心负点 → 期望选中 B（与外接框比，满分约 0.785）
    ms, masks, scores = timed_predict(
        point_coords=np.array([[700, 300], [350, 350]]),
        point_labels=np.array([1, 0]),
        multimask_output=False,
    )
    out["predict_refine_ms"] = round(ms)
    mask_b = masks[0] > 0
    gt_b = np.zeros((768, 1024), bool)
    gt_b[220:381, 620:781] = True
    out["iou_refine"] = round(iou(mask_b, gt_b), 4)

    if device == "cuda":
        out["vram_peak_alloc_gb"] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
        out["vram_peak_reserved_gb"] = round(torch.cuda.max_memory_reserved() / 2**30, 2)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default="sam3", choices=["sam3", "sam2"])
    ap.add_argument("--strategy", required=True, choices=["fp32-gpu", "bf16-gpu", "cpu"])
    ap.add_argument("--ckpt", default="/work/models/sam3.pt")
    ap.add_argument("--fraction", type=float, default=0.28)
    args = ap.parse_args()
    try:
        out = run(args)
    except Exception:
        out = {"strategy": args.strategy, "error": traceback.format_exc(limit=12)}
    path = f"/work/bench-{args.strategy}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    sys.exit(main())
