"""部署后冒烟:容器内直接调 /encode + /segment 验证真实引擎。"""

import base64
import io
import json
import urllib.request

import numpy as np
from PIL import Image, ImageDraw


def post(path, body):
    req = urllib.request.Request(
        "http://127.0.0.1:8300" + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def main():
    img = Image.new("RGB", (1024, 768), (245, 245, 245))
    d = ImageDraw.Draw(img)
    d.rectangle([200, 200, 500, 500], fill=(60, 120, 220))
    d.ellipse([620, 220, 780, 380], fill=(220, 80, 80))
    buf = io.BytesIO()
    img.save(buf, format="PNG")

    enc = post("/encode", {"imageB64": base64.b64encode(buf.getvalue()).decode()})
    print("encode:", enc)

    seg = post("/segment", {"sessionId": enc["sessionId"], "points": [[350, 350]], "labels": [1]})
    arr = np.array(Image.open(io.BytesIO(base64.b64decode(seg["maskPngB64"])))) > 128
    gt = np.zeros((768, 1024), bool)
    gt[200:501, 200:501] = True
    iou = (arr & gt).sum() / (arr | gt).sum()
    print("segment:", {k: seg[k] for k in ("score", "maskWidth", "maskHeight", "decodeMs")})
    print("iou:", round(float(iou), 4))

    seg2 = post(
        "/segment",
        {"sessionId": enc["sessionId"],
         "points": [[700, 300], [350, 350]], "labels": [1, 0]},
    )
    arr2 = np.array(Image.open(io.BytesIO(base64.b64decode(seg2["maskPngB64"])))) > 128
    gt2 = np.zeros((768, 1024), bool)
    gt2[220:381, 620:781] = True
    print("refine iou(bbox 理论上限0.785):",
          round(float((arr2 & gt2).sum() / (arr2 | gt2).sum()), 4))


if __name__ == "__main__":
    main()
