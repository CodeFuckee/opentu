#!/usr/bin/env bash
# image-segmentation edge function 全链路冒烟(真实 JWT + 真实 GPU 服务)
set -euo pipefail

SB=http://10.37.80.25:8021
ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg4MTAyMzUyLCJleHAiOjIxMDM0NjIzNTJ9.nQP_hdmnIbCgVfsxlq6TTuRo_FKVYdrRaIDmKViiEBc'
FN=${SB}/functions/v1/image-segmentation

TOKEN=$(curl -s -X POST "${SB}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON}" -H 'Content-Type: application/json' \
  -d '{"email":"e2e_sync_a@yjk.com","password":"E2eTest_2026!"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

echo "== health =="
curl -s -X POST "${FN}" -H "Authorization: Bearer ${TOKEN}" -H "apikey: ${ANON}" \
  -H 'Content-Type: application/json' -d '{"action":"health"}'
echo

echo "== encode+segment =="
python3 - <<'PYEOF' > /tmp/cutout-req.json
import base64, io, json
from PIL import Image, ImageDraw
img = Image.new("RGB", (800, 600), (250, 250, 250))
d = ImageDraw.Draw(img)
d.rectangle([150, 150, 400, 400], fill=(60, 120, 220))
buf = io.BytesIO(); img.save(buf, format="PNG")
print(json.dumps({"action": "encode", "imageB64": base64.b64encode(buf.getvalue()).decode()}))
PYEOF

ENC=$(curl -s -X POST "${FN}" -H "Authorization: Bearer ${TOKEN}" -H "apikey: ${ANON}" \
  -H 'Content-Type: application/json' -d @/tmp/cutout-req.json)
echo "${ENC}"
SID=$(echo "${ENC}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["sessionId"])')

curl -s -X POST "${FN}" -H "Authorization: Bearer ${TOKEN}" -H "apikey: ${ANON}" \
  -H 'Content-Type: application/json' \
  -d "{\"action\":\"segment\",\"sessionId\":\"${SID}\",\"points\":[[275,275]],\"labels\":[1]}" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d[k] for k in ("score","maskWidth","maskHeight","decodeMs") if k in d} or d)'

echo "== 无 JWT 应 401 =="
curl -s -o /dev/null -w '%{http_code}\n' -X POST "${FN}" -H 'Content-Type: application/json' \
  -d '{"action":"health"}'
