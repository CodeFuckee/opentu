"""segment-server:opentu 智能抠图推理服务(FastAPI)。

仅监听容器网络(不发布端口),由 edge function image-segmentation 做 JWT
鉴权后转发。两阶段交互:/encode 一次编码(重),/segment 每次点击(轻)。

环境变量:
  SEG_CKPT            checkpoint 路径(默认 /models/sam2.1_hiera_large.pt)
  SEG_DEVICE          auto|cuda|cpu(默认 auto)
  SEG_MEM_FRACTION    CUDA 显存软限比例(默认 0.25)
  SEG_MAX_SESSIONS    会话池容量(默认 32)
  SEG_SESSION_TTL_S   会话 TTL 秒(默认 600)
  SEG_PORT            监听端口(默认 8300)
"""

import base64
import io
import logging
import os
import threading
import time

from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError

from .engine import CutoutEngine, resolve_engine_from_env, resize_to_edge
from .masks import mask_to_png_b64
from .sessions import SessionStore
from .validate import (
    RequestError,
    parse_box,
    parse_image_b64,
    parse_labels,
    parse_points,
    parse_session_id,
)

VERSION = "1.0.0"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("segment.server")


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


def create_app(engine: CutoutEngine | None = None) -> FastAPI:
    """engine 为空时按环境变量构造真实引擎(测试注入 FakeEngine)。

    状态(引擎/会话池/清扫线程)在工厂内同步初始化而非 lifespan:
    TestClient 不进 with 也要可用,uvicorn 单进程下行为一致。
    """
    app = FastAPI(title="segment-server", version=VERSION)
    app.state.engine = engine if engine is not None else resolve_engine_from_env()
    app.state.store = SessionStore(
        max_sessions=int(os.environ.get("SEG_MAX_SESSIONS", "32")),
        ttl_seconds=float(os.environ.get("SEG_SESSION_TTL_S", "600")),
    )
    app.state.encode_sem = threading.Semaphore(int(os.environ.get("SEG_ENCODE_CONCURRENCY", "1")))
    app.state.decode_sem = threading.Semaphore(int(os.environ.get("SEG_DECODE_CONCURRENCY", "2")))

    stop = threading.Event()

    def sweeper() -> None:
        while not stop.wait(60):
            n = app.state.store.sweep()
            if n:
                logger.info("session sweep removed %d", n)

    threading.Thread(target=sweeper, daemon=True, name="session-sweeper").start()

    @app.get("/health")
    def health() -> dict[str, Any]:
        eng: CutoutEngine = app.state.engine
        return {
            "status": "ok",
            "version": VERSION,
            "model": eng.model_name,
            "device": eng.device,
            "generation": getattr(eng, "generation", 0),
            "sessions": len(app.state.store),
        }

    @app.post("/encode")
    def encode(body: dict[str, Any]):
        try:
            raw = parse_image_b64(body.get("imageB64"))
        except RequestError as e:
            return error(400, "bad_request", str(e))
        try:
            image = Image.open(io.BytesIO(raw))
            image.load()
            image = resize_to_edge(image.convert("RGB"))
        except (UnidentifiedImageError, OSError, ValueError) as e:
            return error(400, "bad_image", f"无法解码图片: {e}")

        eng: CutoutEngine = app.state.engine
        t0 = time.perf_counter()
        try:
            with app.state.encode_sem:
                handle = eng.encode(image)
        except MemoryError:
            return error(503, "engine_overloaded", "推理引擎内存不足,请稍后重试")
        except Exception as e:  # noqa: BLE001
            logger.exception("encode failed")
            return error(502, "engine_error", f"编码失败: {e}")
        encode_ms = round((time.perf_counter() - t0) * 1000)
        h, w = handle["hw"]  # type: ignore[index]
        sid = app.state.store.put(handle, w, h)
        logger.info(
            "encode sid=%s %dx%d device=%s %dms sessions=%d",
            sid[:8], w, h, eng.device, encode_ms, len(app.state.store),
        )
        return {
            "sessionId": sid,
            "width": w,
            "height": h,
            "device": eng.device,
            "encodeMs": encode_ms,
        }

    @app.post("/segment")
    def segment(body: dict[str, Any]):
        try:
            sid = parse_session_id(body.get("sessionId"))
            points = parse_points(body.get("points"))
            labels = parse_labels(body.get("labels"), len(points))
            box = parse_box(body.get("box"))
        except RequestError as e:
            return error(400, "bad_request", str(e))

        session = app.state.store.get(sid)
        if session is None:
            return error(404, "session_not_found", "会话不存在或已过期,请重新编码图片")

        eng: CutoutEngine = app.state.engine
        if getattr(session.handle, "generation", 0) != getattr(eng, "generation", 0):
            return error(410, "session_stale", "推理设备已变更,请重新编码图片")

        t0 = time.perf_counter()
        try:
            with app.state.decode_sem:
                mask, score = eng.segment(session.handle, points, labels, box)
        except Exception as e:  # noqa: BLE001
            logger.exception("segment failed sid=%s", sid[:8])
            return error(502, "engine_error", f"分割失败: {e}")
        decode_ms = round((time.perf_counter() - t0) * 1000)
        logger.info("segment sid=%s pts=%d box=%s %.0fms score=%.3f",
                    sid[:8], len(points), bool(box), decode_ms, score)
        return {
            "maskPngB64": mask_to_png_b64(mask),
            "score": round(score, 4),
            "maskWidth": int(mask.shape[1]),
            "maskHeight": int(mask.shape[0]),
            "decodeMs": decode_ms,
        }

    return app

# 入口:uvicorn app.main:create_app --factory(工厂模式延迟构造,
# 避免无 torch 环境(测试/CI)import 本模块时加载真实引擎)
