"""segment-server 单元/契约测试(TestClient + FakeEngine,无需 torch)。

运行: cd services/segment-server && python -m pytest tests/ -q
"""

import base64
import io
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, ".")  # 便于直接 python -m pytest

from app.main import create_app  # noqa: E402
from app.masks import mask_to_png_b64  # noqa: E402
from app.sessions import SessionStore  # noqa: E402
from app.validate import RequestError, parse_points  # noqa: E402


class FakeEngine:
    """确定性引擎:掩码=以第一个正点为中心的 200x200 方块(clip 到图内)。"""

    model_name = "fake"
    device = "fake-cpu"
    generation = 0

    def encode(self, image):
        w, h = image.size
        return {"predictor": None, "hw": (h, w), "generation": self.generation}

    def segment(self, handle, points, labels, box):
        h, w = handle["hw"]
        mask = np.zeros((h, w), dtype=np.bool_)
        x, y = points[0]
        mask[max(0, y - 100) : min(h, y + 100), max(0, x - 100) : min(w, x + 100)] = True
        return mask, 0.93


def make_client():
    return TestClient(create_app(engine=FakeEngine()))


def png_b64(w, h, color=(255, 0, 0)) -> str:
    img = Image.new("RGB", (w, h), color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def decode_mask(b64: str) -> np.ndarray:
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    return np.array(img) > 128


# ---------------------------------------------------------------- 校验层

class TestValidate:
    def test_points_ok(self):
        assert parse_points([[1, 2], [3, 4]]) == [(1, 2), (3, 4)]

    def test_points_reject_empty(self):
        with pytest.raises(RequestError):
            parse_points([])

    def test_points_reject_over_limit(self):
        with pytest.raises(RequestError):
            parse_points([[0, 0]] * 17)

    def test_points_reject_float_and_bool(self):
        with pytest.raises(RequestError):
            parse_points([[1.5, 2]])
        with pytest.raises(RequestError):
            parse_points([[True, 2]])

    def test_points_reject_negative(self):
        with pytest.raises(RequestError):
            parse_points([[-1, 2]])


# ---------------------------------------------------------------- 会话池

class TestSessionStore:
    def test_lru_eviction(self):
        t = {"now": 0.0}
        store = SessionStore(max_sessions=2, ttl_seconds=100, clock=lambda: t["now"])
        s1 = store.put("h1", 10, 10)
        t["now"] += 1
        s2 = store.put("h2", 10, 10)  # 顺序 [s1, s2]
        store.get(s1)  # s1 变为最近使用 → 顺序 [s2, s1]
        t["now"] += 1
        s3 = store.put("h3", 10, 10)  # 挤掉最久未用的 s2
        assert store.get(s1) is not None
        assert store.get(s2) is None
        assert store.get(s3) is not None

    def test_ttl_expiry(self):
        t = {"now": 0.0}
        store = SessionStore(max_sessions=5, ttl_seconds=10, clock=lambda: t["now"])
        sid = store.put("h", 10, 10)
        t["now"] += 11
        assert store.get(sid) is None
        assert len(store) == 0

    def test_sweep(self):
        t = {"now": 0.0}
        store = SessionStore(max_sessions=5, ttl_seconds=10, clock=lambda: t["now"])
        store.put("a", 1, 1)
        store.put("b", 1, 1)
        t["now"] += 20
        assert store.sweep() == 2

    def test_on_evict_callback(self):
        evicted = []
        store = SessionStore(max_sessions=1, ttl_seconds=100, clock=lambda: 0.0,
                             on_evict=lambda s: evicted.append(s.id))
        store.put("a", 1, 1)
        store.put("b", 1, 1)
        assert len(evicted) == 1


# ---------------------------------------------------------------- 掩码编码

def test_mask_to_png_b64_roundtrip():
    mask = np.zeros((7, 9), dtype=np.bool_)
    mask[2:5, 3:7] = True
    out = decode_mask(mask_to_png_b64(mask))
    assert out.shape == (7, 9)
    assert (out == mask).all()


# ---------------------------------------------------------------- HTTP 契约

class TestApi:
    def test_encode_segment_roundtrip(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": png_b64(300, 200)})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["width"] == 300 and data["height"] == 200
        assert data["device"] == "fake-cpu"

        r2 = client.post(
            "/segment",
            json={"sessionId": data["sessionId"],
                  "points": [[150, 100]], "labels": [1]},
        )
        assert r2.status_code == 200, r2.text
        seg = r2.json()
        mask = decode_mask(seg["maskPngB64"])
        assert mask.shape == (200, 300)
        assert mask[100, 150]  # 中心在方块内
        assert not mask[5, 5]  # 左上角在方块外
        assert seg["score"] == pytest.approx(0.93)

    def test_encode_downscales_to_1024(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": png_b64(2048, 1024)})
        assert r.status_code == 200
        assert r.json()["width"] == 1024 and r.json()["height"] == 512

    def test_encode_rejects_bad_base64(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": "!!!not-base64!!!"})
        assert r.status_code == 400
        assert r.json()["error"] == "bad_request"

    def test_encode_rejects_non_image(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": base64.b64encode(b"hello").decode()})
        assert r.status_code == 400
        assert r.json()["error"] == "bad_image"

    def test_encode_missing_field(self):
        client = make_client()
        assert client.post("/encode", json={}).status_code == 400

    def test_segment_unknown_session(self):
        client = make_client()
        r = client.post(
            "/segment",
            json={"sessionId": "01234567-89ab-cdef-0123-456789abcdef",
                  "points": [[1, 1]], "labels": [1]},
        )
        assert r.status_code == 404
        assert r.json()["error"] == "session_not_found"

    def test_segment_stale_generation(self):
        app = create_app(engine=FakeEngine())
        with TestClient(app) as c:
            r = c.post("/encode", json={"imageB64": png_b64(50, 50)})
            sid = r.json()["sessionId"]
            app.state.engine.generation = 1  # 模拟设备降级
            r2 = c.post("/segment", json={"sessionId": sid, "points": [[10, 10]], "labels": [1]})
            assert r2.status_code == 410
            assert r2.json()["error"] == "session_stale"

    def test_segment_validates_points(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": png_b64(50, 50)})
        sid = r.json()["sessionId"]
        for bad in (
            {"points": [], "labels": []},
            {"points": [[1, 1]] * 17, "labels": [1] * 17},
            {"points": [[1, 1]], "labels": [2]},
            {"points": [[1, 1]], "labels": []},
            {"points": [[1, 1]], "labels": [1], "box": [5, 5, 5, 10]},
            {"points": [[-2, 1]], "labels": [1]},
        ):
            resp = client.post("/segment", json={"sessionId": sid, **bad})
            assert resp.status_code == 400, bad

    def test_segment_accepts_box(self):
        client = make_client()
        r = client.post("/encode", json={"imageB64": png_b64(60, 60)})
        sid = r.json()["sessionId"]
        r2 = client.post(
            "/segment",
            json={"sessionId": sid, "points": [[30, 30]], "labels": [1],
                  "box": [10, 10, 50, 50]},
        )
        assert r2.status_code == 200

    def test_health(self):
        client = make_client()
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["model"] == "fake"
        assert "sessions" in body
