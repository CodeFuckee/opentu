#!/bin/bash
# 建筑学长模板每日同步（opentu 模板中心）
# 逐页调用 template-crawler（每页一次函数调用，规避 edge-runtime CPU 时间限制）
# 用法: crawl-templates.sh [endPage=59] [pageSize=30] [force=false]
# 输出: 每页一行 JSON（totalListed/inserted/updated/skipped/failed/errors）
#
# 2026-10-05 修复：①自铸 JWT 15 分钟过期——全量跑到 ~54 页起全部
#   unauthorized，深页模板静默断供多日；改为每 40 页重铸 + 遇 invalid token
#   立即重铸重试一次。②脚本原先不识别 error 行、恒以 0 退出——每日
#   automation 判定"正常"从未告警；改为统计错误行，非零即 exit 1。
END_PAGE="${1:-59}"
PAGE_SIZE="${2:-30}"
FORCE="${3:-false}"
SECRET=$(docker exec supabase-edge-functions printenv JWT_SECRET)
SUB=$(docker exec supabase-db psql -U supabase_admin -d postgres -tAc "select id from auth.users where email like 'chenkaidi%' limit 1" | tr -d "
")
if [ -z "$SUB" ]; then echo "ERROR: admin user not found"; exit 1; fi

mint_jwt() {
  python3 - "$SECRET" "$SUB" <<PY
import hmac, hashlib, base64, json, sys, time
secret, sub = sys.argv[1], sys.argv[2]
b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
now = int(time.time())
header = b64u(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
payload = b64u(json.dumps({"sub":sub,"role":"authenticated","aud":"authenticated","iss":"https://supabase-demo.supabase.co/auth/v1","iat":now,"exp":now+900}).encode())
sig = b64u(hmac.new(secret.encode(), (header + "." + payload).encode(), hashlib.sha256).digest())
print(header + "." + payload + "." + sig)
PY
}

JWT=$(mint_jwt)
ERRORS=0
ZEROS=0
for ((p=0; p<=END_PAGE; p++)); do
  if (( p > 0 && p % 40 == 0 )); then
    JWT=$(mint_jwt)
  fi
  RESP=$(curl -s -m 90 -X POST "http://localhost:8021/functions/v1/template-crawler"     -H "Authorization: Bearer $JWT" -H "Content-Type: application/json"     -d "{\"action\":\"crawl\",\"startPage\":$p,\"maxPages\":1,\"pageSize\":$PAGE_SIZE,\"withCovers\":true,\"force\":$FORCE}")
  if echo "$RESP" | grep -q "invalid token"; then
    JWT=$(mint_jwt)
    RESP=$(curl -s -m 90 -X POST "http://localhost:8021/functions/v1/template-crawler"       -H "Authorization: Bearer $JWT" -H "Content-Type: application/json"       -d "{\"action\":\"crawl\",\"startPage\":$p,\"maxPages\":1,\"pageSize\":$PAGE_SIZE,\"withCovers\":true,\"force\":$FORCE}")
  fi
  echo "[page $p] $RESP"
  if echo "$RESP" | grep -qE '"error"|invalid token|WorkerRequestCancelled' || [ -z "$RESP" ]; then
    ERRORS=$((ERRORS+1))
  fi
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
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS 页错误（invalid token/空响应/函数错误）"
  exit 1
fi
echo "OK"
