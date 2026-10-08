"""请求体校验(纯逻辑,无 torch 依赖)。"""

import base64
import binascii
import re
from typing import Any

MAX_POINTS = 16
MAX_COORD = 8191  # /encode 后图片长边 ≤1024,坐标上限留足余量
MAX_IMAGE_B64_CHARS = 8_000_000  # 约 6MB 二进制

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class RequestError(ValueError):
    """校验失败;FastAPI 层统一转 400。"""


def parse_image_b64(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise RequestError("imageB64 必须为非空字符串")
    if len(value) > MAX_IMAGE_B64_CHARS:
        raise RequestError("imageB64 过大(超过约 6MB)")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as e:
        raise RequestError(f"imageB64 不是合法 base64: {e}") from e


def parse_session_id(value: Any) -> str:
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise RequestError("sessionId 格式非法")
    return value


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def parse_points(value: Any) -> list[tuple[int, int]]:
    if not isinstance(value, list) or not value:
        raise RequestError("points 必须为非空数组")
    if len(value) > MAX_POINTS:
        raise RequestError(f"点数超过上限 {MAX_POINTS}")
    pts = []
    for p in value:
        if not isinstance(p, list) or len(p) != 2:
            raise RequestError("每个点必须为 [x, y]")
        if not all(_is_int(c) and 0 <= c <= MAX_COORD for c in p):
            raise RequestError(f"点坐标必须为 0..{MAX_COORD} 的整数")
        pts.append((p[0], p[1]))
    return pts


def parse_labels(value: Any, point_count: int) -> list[int]:
    if not isinstance(value, list) or len(value) != point_count:
        raise RequestError("labels 长度必须与 points 一致")
    for v in value:
        if not _is_int(v) or v not in (0, 1):
            raise RequestError("label 只能为 0(负点) 或 1(正点)")
    return list(value)


def parse_box(value: Any) -> tuple[int, int, int, int] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4:
        raise RequestError("box 必须为 [x1, y1, x2, y2]")
    if not all(_is_int(c) and 0 <= c <= MAX_COORD for c in value):
        raise RequestError(f"box 坐标必须为 0..{MAX_COORD} 的整数")
    x1, y1, x2, y2 = value
    if x2 <= x1 or y2 <= y1:
        raise RequestError("box 要求 x2 > x1 且 y2 > y1")
    return (x1, y1, x2, y2)
