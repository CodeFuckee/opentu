#!/usr/bin/env bash
# ci/e2e-github.sh — opentu E2E 桥接执行体（GitHub Ubuntu runner，自给自足）。
#
# 与自建版（yue-e2e runner）的架构差异：
#   ① 不依赖 LAN Supabase：临时 Supabase 起在本 runner（官方 docker compose 钉版，
#      随作业销毁——测试数据零污染，也无需自建版的数据治理/清理步骤）；
#   ② 不依赖宿主机 docker exec/psql：迁移与种子经 `docker compose exec -T db psql`
#      应用到临时实例；测试账号经 auth admin API（service_role）引导；
#   ③ Playwright 浏览器不共享：playwright install --with-deps chromium 自装
#      （runner 允许 sudo）。
# PNPM_VERSION 由 MACOS_ENV_PASSTHROUGH 透传。
# 产物：dist/（playwright-report + test-results），由桥接 workflow 回传 package registry。
set -euo pipefail
cd "${CI_PROJECT_DIR:?CI_PROJECT_DIR 未注入}"

SUPABASE_RELEASE="${SUPABASE_RELEASE:-v1.26.08}"
SUPA_DIR="$HOME/supabase-stack"
STACK_URL="http://127.0.0.1:8021"
E2E_ARGS="${E2E_ARGS:---project=smoke --project=functional}"

echo "[e2e] ① 下载并启动临时 Supabase（${SUPABASE_RELEASE}）"
rm -rf "$SUPA_DIR" && mkdir -p "$SUPA_DIR" && cd "$SUPA_DIR"
curl -fsSL -o /tmp/supa.tgz \
  "https://github.com/supabase/supabase/archive/refs/tags/${SUPABASE_RELEASE}.tar.gz"
tar -xzf /tmp/supa.tgz -C /tmp
cp -r "/tmp/supabase-${SUPABASE_RELEASE#v}/docker/." .
cp .env.example .env
# API 网关(Kong)映射到 8021：与自建实例端口习惯一致
sed -i 's/^HTTP_PORT=.*/HTTP_PORT=8021/' .env
docker compose up -d --quiet-pull
for i in $(seq 1 60); do
  curl -sf "${STACK_URL}/auth/v1/health" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "supabase 5 分钟未就绪" >&2; docker compose logs --tail 40 >&2; exit 1; }
  sleep 5
done
echo "[e2e] Supabase 就绪"

ANON_KEY=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
SERVICE_ROLE=$(grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)

echo "[e2e] ② 应用迁移与种子（字母序、容错续跑——迁移均为幂等风格）"
cd "$CI_PROJECT_DIR"
for f in supabase/migrations/*.sql; do
  echo "  · $(basename "$f")"
  docker compose -f "$SUPA_DIR/docker-compose.yaml" exec -T db \
    psql -v ON_ERROR_STOP=0 -U supabase_admin -d postgres < "$f" >/dev/null \
    || echo "  ⚠ ${f##*/} 有报错（继续）"
done
for f in supabase/seed/*.sql; do
  echo "  · seed/$(basename "$f")"
  docker compose -f "$SUPA_DIR/docker-compose.yaml" exec -T db \
    psql -v ON_ERROR_STOP=0 -U supabase_admin -d postgres < "$f" >/dev/null \
    || echo "  ⚠ ${f##*/} 有报错（继续）"
done

echo "[e2e] ③ 引导测试账号池（e2e_sync_a..h）与存储桶"
api() { curl -sS -X "$1" "${STACK_URL}$2" -H "apikey: $3" -H "Authorization: Bearer $3" \
        -H 'Content-Type: application/json' ${4:+-d "$4"}; }
api POST /storage/v1/bucket "$SERVICE_ROLE" '{"id":"yue-sync","name":"yue-sync","public":false}' \
  >/dev/null || echo "  ⚠ yue-sync 桶已存在"
api POST /storage/v1/bucket "$SERVICE_ROLE" '{"id":"ai-outputs","name":"ai-outputs","public":true}' \
  >/dev/null || echo "  ⚠ ai-outputs 桶已存在"
PW="${E2E_TEST_PASSWORD:-E2eTest_2026!}"
for a in a b c d e f g h; do
  code=$(api POST /auth/v1/admin/users "$SERVICE_ROLE" \
    "{\"email\":\"e2e_sync_${a}@yjk.com\",\"password\":\"${PW}\",\"email_confirm\":true}" \
    -o /dev/null -w '%{http_code}' || echo 000)
  [ "$code" = "200" ] && echo "  · e2e_sync_${a} 已创建" \
    || echo "  · e2e_sync_${a} 跳过（HTTP ${code}，通常=已存在）"
done

echo "[e2e] ④ 安装依赖与 Playwright（--with-deps 自装系统包与浏览器）"
corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null || corepack enable
export PATH="$HOME/.local/bin:$PATH"
corepack prepare "pnpm@${PNPM_VERSION:?PNPM_VERSION 未透传}" --activate
pnpm config set store-dir .pnpm-store
pnpm install --frozen-lockfile
sudo -E env "PATH=$PATH" pnpm exec playwright install --with-deps chromium

echo "[e2e] ⑤ 运行 E2E（${E2E_ARGS}；webServer=preview 生产产物模式）"
export VITE_SUPABASE_URL="$STACK_URL"
export VITE_SUPABASE_ANON_KEY="$ANON_KEY"
export E2E_SUPABASE_URL="$STACK_URL"
export E2E_SUPABASE_ANON_KEY="$ANON_KEY"
export E2E_TEST_PASSWORD="$PW"
if [ -n "$E2E_ARGS" ]; then
  pnpm exec nx e2e web-e2e -- $E2E_ARGS
else
  pnpm exec nx e2e web-e2e
fi

echo "[e2e] ⑥ 收集报告进 dist/"
mkdir -p dist
cp -r apps/web-e2e/playwright-report dist/ 2>/dev/null || true
cp -r apps/web-e2e/test-results dist/ 2>/dev/null || true
echo "[e2e] 完成"
