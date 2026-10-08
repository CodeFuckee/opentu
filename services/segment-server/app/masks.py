"""掩码编码:bool ndarray → 二值 PNG(base64)。"""

import base64
import io

import numpy as np
from PIL import Image


def mask_to_png_b64(mask: np.ndarray) -> str:
    """bool HxW 掩码 → 0/255 的灰度 PNG base64(无压缩损耗,前端按阈值 128 解码)。"""
    if mask.ndim != 2 or mask.dtype != np.bool_:
        raise ValueError(f"掩码必须为 2D bool 数组,得到 {mask.dtype}/{mask.shape}")
    png = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
    buf = io.BytesIO()
    png.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")
