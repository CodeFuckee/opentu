#!/usr/bin/env bash
# 清理探测阶段产生的测试 token，只保留当前 user_profiles.apikey 对应的那个。
set -e
STORED=$(docker exec supabase-db psql -U supabase_admin -d postgres -t -A -c "select apikey from user_profiles where oa_account='chenkaidi'")
STORED_RAW=${STORED#sk-}
PW=$(docker exec supabase-db psql -U supabase_admin -d postgres -t -A -c "select newapi_password from user_profiles where oa_account='chenkaidi'")
AT=$(curl -s -m10 -X POST http://10.0.0.220:3000/api/user/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"chenkaidi\",\"password\":\"$PW\"}" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

IDS=$(curl -s -m10 "http://10.37.80.25:3000/api/token/?p=1&size=100" -H "Authorization: Bearer $AT" | grep -o '"id":[0-9]*' | cut -d: -f2 | sort -un)
DELETED=""
for ID in $IDS; do
  K=$(curl -s -m10 -X POST "http://10.37.80.25:3000/api/token/$ID/key" -H "Authorization: Bearer $AT" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)
  if [ "$K" != "$STORED_RAW" ]; then
    curl -s -m10 -X DELETE "http://10.37.80.25:3000/api/token/$ID" -H "Authorization: Bearer $AT" >/dev/null
    DELETED="$DELETED $ID"
  fi
done
echo "deleted_tokens:$DELETED"
