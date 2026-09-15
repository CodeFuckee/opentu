#!/bin/bash
# 建筑学长模板每日同步（opentu 模板中心）
# 逐页调用 template-crawler（每页一次函数调用，规避 edge-runtime CPU 时间限制）
# 用法: crawl-templates.sh [endPage=59] [pageSize=30] [force=false]
# 输出: 每页一行 JSON（totalListed/inserted/updated/skipped/failed/errors）
END_PAGE="${1:-59}"
PAGE_SIZE="${2:-30}"
FORCE="${3:-false}"
SECRET=$(docker exec supabase-edge-functions printenv JWT_SECRET)
SUB=$(docker exec supabase-db psql -U supabase_admin -d postgres -tAc "select id from auth.users where email like 'chenkaidi%' limit 1" | tr -d "\r\n")
if [ -z "$SUB" ]; then echo "ERROR: admin user not found"; exit 1; fi
JWT=$(python3 - "$SECRET" "$SUB" <<PY
import hmac, hashlib, base64, json, sys, time
secret, sub = sys.argv[1], sys.argv[2]
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
header = b64u(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
payload = b64u(json.dumps({"sub":sub,"role":"authenticated","aud":"authenticated","iss":"https://supabase-demo.supabase.co/auth/v1","iat":now,"exp":now+900}).encode())
sig = b64u(hmac.new(secret.encode(), (header + "." + payload).encode(), hashlib.sha256).digest())
print(header + "." + payload + "." + sig)
PY
)
ZEROS=0
for ((p=0; p<=END_PAGE; p++)); do
  RESP=$(curl -s -m 90 -X POST "http://localhost:8021/functions/v1/template-crawler" \
    -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
    -d "{\"action\":\"crawl\",\"startPage\":$p,\"maxPages\":1,\"pageSize\":$PAGE_SIZE,\"withCovers\":true,\"force\":$FORCE}")
  echo "[page $p] $RESP"
  ZERO=$(echo "$RESP" | python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  print(1 if d.get(\"byType\",[{}])[0].get(\"totalListed\")==0 else 0)
except Exception:
  print(0)" 2>/dev/null)
  if [ "$ZERO" = "1" ]; then
    ZEROS=$((ZEROS+1))
    if [ "$ZEROS" -ge 2 ]; then echo "DONE: 连续空页，全部模板已同步"; break; fi
  else
    ZEROS=0
  fi
  sleep 1
done
