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
# API 网关(Kong)映射到 8021：与自建实例端口习惯一致。
# 注意 .env 变量名随版本变化：老版 HTTP_PORT，v1.26+ 是 KONG_HTTP_PORT（映射
# "${KONG_HTTP_PORT}:8000/tcp"）——两个都改，谁存在谁生效
sed -i 's/^KONG_HTTP_PORT=.*/KONG_HTTP_PORT=8021/; s/^HTTP_PORT=.*/HTTP_PORT=8021/' .env
# 仓库自定义 edge functions 覆盖部署（ui-stats/asset-vector-search 等是应用
# 运行时依赖，缺失会以 500 出现在页面控制台，cloud-sync 的"控制台无报错"
# 断言即因此挂）——覆盖官方示例函数，随边缘运行时按目录名提供服务
if [ -d "$CI_PROJECT_DIR/supabase/functions" ]; then
  mkdir -p volumes/functions
  cp -r "$CI_PROJECT_DIR/supabase/functions/." volumes/functions/
fi
docker compose up -d --quiet-pull
ANON_KEY=$(grep '^ANON_KEY=' .env | cut -d= -f2-)
SERVICE_ROLE=$(grep '^SERVICE_ROLE_KEY=' .env | cut -d= -f2-)
# 2 核 runner 首次拉起+初始化较慢，健康等待给足 10 分钟。
# 新版 Kong 对所有路由（含 /auth/v1/health）都要求 apikey——裸 curl 恒 401
for i in $(seq 1 60); do
  curl -sf "${STACK_URL}/auth/v1/health" -H "apikey: ${ANON_KEY}" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "supabase 10 分钟未就绪" >&2; docker compose ps >&2; docker compose logs --tail 30 auth kong >&2; exit 1; }
  sleep 10
done
echo "[e2e] Supabase 就绪"

echo "[e2e] ② 应用迁移与种子（字母序、容错续跑——迁移均为幂等风格）"
# 必须在栈目录内执行 compose exec：-f 指定时项目名取自文件目录（docker），
# 与 up 时（supabase-stack）不一致会导致 exec 连不上运行中的栈
apply_sql() {
  (cd "$SUPA_DIR" && docker compose exec -T db \
    psql -v ON_ERROR_STOP=0 -U supabase_admin -d postgres) < "$1" 2>&1
}
cd "$CI_PROJECT_DIR"
for f in supabase/migrations/*.sql supabase/seed/*.sql; do
  echo "  · ${f#supabase/}"
  out=$(apply_sql "$f") || true
  # pipefail 下 grep 无匹配会让整条管道返回 1，必须内联兜底（set -e 直接杀脚本）
  err=$(grep -aE "ERROR" <<<"$out" | head -2 || true)
  [ -n "$err" ] && { echo "$err" | sed 's/^/    ⚠ /'; } || true
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

echo "[e2e] ③b 自造业务数据（jzxz 素材/向量/文件）"
python3 - <<'PYSEED'
import json, os, random, struct, urllib.request

STACK = os.environ["STACK_URL"]
SROLE = os.environ["SERVICE_ROLE"]

def upload(bucket, path, data, ctype):
    req = urllib.request.Request(
        f"{STACK}/storage/v1/object/{bucket}/{path}", data=data, method="POST",
        headers={"apikey": SROLE, "Authorization": f"Bearer {SROLE}",
                 "Content-Type": ctype, "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()

def png_bytes(w, h, rgb):
    import zlib
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

def glb_bytes():
    # 最小合法 GLB：单三角网格（model-viewer 可加载渲染）
    positions = [0,0,0, 1,0,0, 0,1,0]
    indices = [0,1,2]
    bin_data = struct.pack("<9f", *positions) + struct.pack("<3H", *indices)
    bin_data += b"\x00" * ((4 - len(bin_data) % 4) % 4)
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 1}, "indices": 0, "mode": 4}]}],
        "accessors": [
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"},
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
             "min": [0,0,0], "max": [1,1,0]},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": len(struct.pack("<9f", *positions)),
             "byteLength": 6, "target": 34963},
            {"buffer": 0, "byteOffset": 0, "byteLength": 36, "target": 34962},
        ],
        "buffers": [{"byteLength": len(bin_data)}],
    }
    js = json.dumps(gltf).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_data)
    return (struct.pack("<4sII", b"glTF", 2, total)
            + struct.pack("<4sI", b"JSON", len(js)) + js
            + struct.pack("<4sI", b"BIN\x00", len(bin_data)) + bin_data)

rng = random.Random(42)
def rand_vec():
    v = [rng.uniform(-1, 1) for _ in range(512)]
    n = sum(x*x for x in v) ** 0.5
    return "[" + ",".join(f"{x/n:.6f}" for x in v) + "]"

# 上传素材文件（公开桶由迁移创建）
glb = glb_bytes()
upload("jzxz-home-materials", "e2e/betty.glb", glb, "model/gltf-binary")
upload("jzxz-home-materials", "e2e/betty-cover.png", png_bytes(64, 64, (180, 140, 90)), "image/png")
for i, rgb in enumerate([(120, 160, 200), (200, 120, 120), (120, 200, 140)], 1):
    upload("jzxz-materials", f"e2e/tex-{i}.png", png_bytes(64, 64, rgb), "image/png")

# 业务行（psql 由外层 apply_sql 应用）
sql = """
insert into jzxz_home_materials (source_id, name, category, tags, image_paths, glb_path, glb_bytes, glb_name)
values ('e2e-betty', '餐椅丨BETTY TK3', '家居库', '{餐椅,e2e}',
        '["e2e/betty-cover.png"]'::jsonb, 'e2e/betty.glb', %(glb_bytes)s, 'betty.glb')
on conflict (source_id) do nothing;
insert into jzxz_materials (source_id, gallery, category, tag, name, width, height, preview_path, file_path)
values ('e2e-tex-1','家居库','贴图','e2e','E2E-TEX-1',64,64,'e2e/tex-1.png','e2e/tex-1.png'),
       ('e2e-tex-2','家居库','贴图','e2e','E2E-TEX-2',64,64,'e2e/tex-2.png','e2e/tex-2.png'),
       ('e2e-tex-3','家居库','贴图','e2e','E2E-TEX-3',64,64,'e2e/tex-3.png','e2e/tex-3.png')
on conflict (source_id) do nothing;
insert into asset_vectors (asset_type, asset_id, image_url, embedding, model_version)
values ('jzxz_home_materials','e2e-betty',
        '%(base)s/storage/v1/object/public/jzxz-home-materials/e2e/betty-cover.png',
        '%(v1)s'::vector,'clip-vit-b32-int8-v1'),
       ('jzxz_materials','e2e-tex-1',
        '%(base)s/storage/v1/object/public/jzxz-materials/e2e/tex-1.png',
        '%(v2)s'::vector,'clip-vit-b32-int8-v1')
on conflict (asset_type, asset_id, image_url) do nothing;
""" % {"glb_bytes": len(glb),
       "base": STACK,
       "v1": rand_vec(), "v2": rand_vec()}
open("/tmp/e2e-seed.sql", "w").write(sql)
print("[seed] 文件已上传，SQL 就绪")
PYSEED
apply_sql /tmp/e2e-seed.sql >/dev/null 2>&1 || true
echo "[e2e] ③b 完成"

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
