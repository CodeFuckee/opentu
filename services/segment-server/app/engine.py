"""推理引擎封装:接口与实现分离,实现可在 sam2 / 未来 sam3 间替换。

CutoutEngine 协议是服务层唯一依赖;Sam2Engine 懒加载 sam3 代码路径
(实际为 vendor 的 sam2 包),CI 单测用 FakeEngine 不需要 torch。
"""

import copy
import logging
import os
import time
from typing import Protocol, runtime_checkable

import numpy as np
from PIL import Image

logger = logging.getLogger("segment.engine")

SAM2_CONFIG = "configs/sam2.1/sam2.1_hiera_l.yaml"
MAX_EDGE = 1024


def resize_to_edge(image: Image.Image, max_edge: int = MAX_EDGE) -> Image.Image:
    """长边超过 max_edge 时等比缩小(LANCZOS);小图原样返回。"""
    w, h = image.size
    if max(w, h) <= max_edge:
        return image
    scale = max_edge / max(w, h)
    return image.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


@runtime_checkable
class CutoutEngine(Protocol):
    model_name: str
    device: str
    """generation 在设备降级(CUDA→CPU)时递增:旧句柄缓存的 GPU 特征失效,
    /segment 校验会话记录的代数,不一致返回 410 让前端重新编码。"""
    generation: int

    def encode(self, image: Image.Image) -> object:
        """图片 → 不透明会话句柄(含推理特征)。"""
        ...

    def segment(
        self,
        handle: object,
        points: list[tuple[int, int]],
        labels: list[int],
        box: tuple[int, int, int, int] | None,
    ) -> tuple[np.ndarray, float]:
        """句柄 + 点/框 → (bool HxW 掩码, 置信分)。"""
        ...


class Sam2Engine:
    """SAM 2.1 hiera-large(GPU fp32 优先,CUDA OOM 自动降级 CPU)。

    M0 实测(RTX 5080, 1024px):编码稳态 ~105ms,单点 98ms,细化 27ms,
    显存峰值 1.4GB;CPU 32 线程编码 3.8–6.5s。fp32 即满足性能预算,无需量化。
    """

    def __init__(self, ckpt_path: str, device: str = "auto", mem_fraction: float = 0.25):
        import torch  # noqa: PLC0415 - 延迟导入,单测/CI 不需要
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        self._torch = torch
        self.model_name = "sam2.1_hiera_large"
        self.generation = 0
        self._ckpt = ckpt_path
        self._mem_fraction = mem_fraction

        resolved = device
        if device == "auto":
            resolved = "cuda" if torch.cuda.is_available() else "cpu"
        if resolved == "cuda" and mem_fraction > 0:
            torch.cuda.set_per_process_memory_fraction(mem_fraction, 0)
        self.device = resolved
        logger.info("loading %s on %s", self.model_name, self.device)
        t0 = time.perf_counter()
        self.model = build_sam2(SAM2_CONFIG, ckpt_path, device=self.device)
        # 模板 predictor:变换管线(torch.jit.script)只构建一次,
        # 每会话浅拷贝实例共享无状态变换与底层模型,会话特征各自独立。
        self._template = SAM2ImagePredictor(self.model)
        logger.info("model loaded in %.1fs", time.perf_counter() - t0)

    def _new_predictor(self):
        p = copy.copy(self._template)
        p.reset_predictor()
        return p

    def _fallback_cpu(self) -> None:
        logger.warning("CUDA OOM,降级 CPU(model 就地迁移,generation+1 使旧会话失效)")
        self.device = "cpu"
        self.model = self.model.to("cpu")
        self.generation += 1

    def encode(self, image: Image.Image) -> object:
        torch = self._torch
        image = resize_to_edge(image)
        for attempt in (0, 1):
            try:
                predictor = self._new_predictor()
                predictor.set_image(image)
                return {
                    "predictor": predictor,
                    "hw": (image.height, image.width),
                    "generation": self.generation,
                }
            except torch.cuda.OutOfMemoryError:  # type: ignore[attr-defined]
                if attempt == 0 and self.device == "cuda":
                    self._fallback_cpu()
                    continue
                raise
        raise RuntimeError("unreachable")

    def segment(
        self,
        handle: object,
        points: list[tuple[int, int]],
        labels: list[int],
        box: tuple[int, int, int, int] | None,
    ) -> tuple[np.ndarray, float]:
        torch = self._torch
        h = handle  # type: ignore[assignment]
        coords = np.array(points, dtype=np.float32)
        lab = np.array(labels, dtype=np.int64)
        # 单点且无框时输出 3 候选取最优;多点/有框输出单掩码(SAM 惯例)
        multimask = len(points) == 1 and box is None
        masks, scores, _ = h["predictor"].predict(
            point_coords=coords,
            point_labels=lab,
            box=np.array(box, dtype=np.float32) if box else None,
            multimask_output=multimask,
        )
        if multimask:
            best = int(np.argmax(scores))
            return masks[best] > 0, float(scores[best])
        return masks[0] > 0, float(scores[0])


def resolve_engine_from_env() -> CutoutEngine:
    """生产入口:按环境变量构造真实引擎。"""
    ckpt = os.environ.get("SEG_CKPT", "/models/sam2.1_hiera_large.pt")
    device = os.environ.get("SEG_DEVICE", "auto")
    mem_fraction = float(os.environ.get("SEG_MEM_FRACTION", "0.25"))
    return Sam2Engine(ckpt, device=device, mem_fraction=mem_fraction)
