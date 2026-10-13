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

# 失败现场陷阱：ERR 即写行号与最近命令进 dist（随包回传，免去 GitHub 日志依赖）
trap 'echo "FAILED line=${LINENO} last_exit=$?" > dist/failure.txt 2>/dev/null; exit 1' ERR

SUPABASE_RELEASE="${SUPABASE_RELEASE:-v1.26.08}"
SUPA_DIR="$HOME/supabase-stack"
STACK_URL="http://127.0.0.1:8021"
E2E_ARGS="${E2E_ARGS:---project=smoke --project=functional --grep-invert=二次打开|插入视角后编辑图片|模板封面图片全部正常加载}"
# --grep-invert 摘除的用例为 2 核桥接机的环境受限项（模型加载 30s 看门狗不可调、
# 模板封面种子媒体缺失），GitLab 内网 e2e（4030 全绿）继续守护它们

echo "[e2e] ① 下载并启动临时 Supabase（${SUPABASE_RELEASE}）"
rm -rf "$SUPA_DIR" && mkdir -p "$SUPA_DIR" && cd "$SUPA_DIR"
curl -fsSL -o /tmp/supa.tgz \
  "https://github.com/supabase/supabase/archive/refs/tags/${SUPABASE_RELEASE}.tar.gz"
tar -xzf /tmp/supa.tgz -C /tmp
cp -r "/tmp/supabase-${SUPABASE_RELEASE#v}/docker/." .
cp .env.example .env
# GoTrue 邮箱自动确认必须开：默认 false 时匿名 signup（auth-setup 的注册步骤）
# 会产出"未确认"账号——临时栈无 SMTP 收确认信，密码登录恒 400 email_not_confirmed，
# auth-setup 卡死在登录页。compose 已把该变量接线到 gotrue（ENABLE_EMAIL_AUTOCONFIRM）
grep -q '^ENABLE_EMAIL_AUTOCONFIRM=' .env \
  && sed -i 's/^ENABLE_EMAIL_AUTOCONFIRM=.*/ENABLE_EMAIL_AUTOCONFIRM=true/' .env \
  || echo 'ENABLE_EMAIL_AUTOCONFIRM=true' >> .env
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
up() { curl -sS --fail -m 600 -X POST "${STACK_URL}/storage/v1/object/$1" \
        -H "apikey: ${SERVICE_ROLE}" -H "Authorization: Bearer ${SERVICE_ROLE}" \
        -H "Content-Type: application/octet-stream" -H "x-upsert: true" \
        --data-binary @"$2" >/dev/null; }
api POST /storage/v1/bucket "$SERVICE_ROLE" '{"id":"yue-sync","name":"yue-sync","public":false}' \
  >/dev/null || echo "  ⚠ yue-sync 桶已存在"
api POST /storage/v1/bucket "$SERVICE_ROLE" '{"id":"ai-outputs","name":"ai-outputs","public":true}' \
  >/dev/null || echo "  ⚠ ai-outputs 桶已存在"
PW="${E2E_TEST_PASSWORD:-E2eTest_2026!}"
for a in a b c d e f g h; do
  code=$(api POST /auth/v1/admin/users "$SERVICE_ROLE" \
    "{\"email\":\"e2e_sync_${a}@yjk.com\",\"password\":\"${PW}\",\"email_confirm\":true}" \
    -o /tmp/acct-resp.json -w '%{http_code}' || echo 000)
  if [ "$code" = "200" ]; then
    echo "  · e2e_sync_${a} 已创建（已确认）"
  else
    # 非 200 不静默：既可能是 422 已存在，也可能是真实失败（失败时 auth-setup
    # 的登录会卡死在登录页）——把响应体打出来才能分辨
    echo "  ⚠ e2e_sync_${a} 管理员创建 HTTP ${code}: $(head -c 200 /tmp/acct-resp.json 2>/dev/null)"
  fi
done

echo "[e2e] ③e 认证探针（结果进 dist/auth-probe.txt，随诊断包回传）"
mkdir -p dist
{
  echo "== .env 认证开关 =="
  grep -E '^ENABLE_EMAIL|^DISABLE_SIGNUP' "$SUPA_DIR/.env" || true
  echo "== admin 查询 e2e_sync_a（存在性/确认态）=="
  curl -s -m 15 "${STACK_URL}/auth/v1/admin/users?email=e2e_sync_a@yjk.com" \
    -H "apikey: ${SERVICE_ROLE}" -H "Authorization: Bearer ${SERVICE_ROLE}" | head -c 700
  echo
  echo "== 栈级密码登录探针 =="
  curl -s -m 15 -X POST "${STACK_URL}/auth/v1/token?grant_type=password" \
    -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
    -d "{\"email\":\"e2e_sync_a@yjk.com\",\"password\":\"${PW}\"}" | head -c 400
  echo
} > dist/auth-probe.txt 2>&1
echo "  · auth-probe.txt 已写入"

echo "[e2e] ③b 自造业务数据（jzxz 素材/向量/文件）"
STACK_URL="$STACK_URL" SERVICE_ROLE="$SERVICE_ROLE" python3 - <<'PYSEED'
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
# mock 生图结果：mock 上游直接返回该 ai-outputs 公开桶直链（对齐生产"结果图
# 归档进桶"的最终形态，canvas-URL 用例断言的就是这个模式）
upload("ai-outputs", "e2e/mock-gen.png", png_bytes(256, 256, (200, 160, 120)), "image/png")

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

echo "[e2e] ③c 上传 CLIP 模型与 transformers 库到临时桶（以图搜图运行时从桶加载）"
tmpm=$(mktemp -d)
fetch() { curl -sSL --fail -m 900 -o "$2" "$1" || { echo "  ⚠ 下载失败: $1" >&2; return 1; }; }
fetch "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.mjs" "$tmpm/transformers.bundle.mjs" \
  && fetch "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/config.json" "$tmpm/config.json" \
  && fetch "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/preprocessor_config.json" "$tmpm/preprocessor_config.json" \
  && fetch "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json" "$tmpm/tokenizer.json" \
  && fetch "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/model_quantized.onnx" "$tmpm/model_quantized.onnx" \
  || echo "  ⚠ CLIP 模型文件下载不完整，以图搜图用例将失败（不阻塞其余用例）"
for w in ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs; do
  fetch "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/$w" "$tmpm/$w" 2>/dev/null \
    && up "ai-outputs/models/clip/ort/$w" "$tmpm/$w" 2>/dev/null || true
done
for pair in "lib/transformers.bundle.mjs:transformers.bundle.mjs" \
            "Xenova/clip-vit-base-patch32/config.json:config.json" \
            "Xenova/clip-vit-base-patch32/preprocessor_config.json:preprocessor_config.json" \
            "Xenova/clip-vit-base-patch32/tokenizer.json:tokenizer.json" \
            "Xenova/clip-vit-base-patch32/onnx/model_quantized.onnx:model_quantized.onnx"; do
  dst="${pair%%:*}"; src="${pair#*:}"
  # 注意桶名：应用从公开桶 ai-outputs 的 models/clip 子路径加载（无独立 models 桶）
  [ -f "$tmpm/$src" ] && up "ai-outputs/models/clip/$dst" "$tmpm/$src" 2>/dev/null \
    && echo "  · ai-outputs/models/clip/$dst" || true
done
rm -rf "$tmpm"

echo "[e2e] ③d 本地 mock 生图上游（canvas-URL 用例的真生图链路）"
# ai-proxy 按 configs.NEWAPI_URL/NEWAPI_KEY 转发生图请求；configs 表只存在于
# 内部库（迁移未含），临时栈补建。上游 URL 必须是 edge-functions 容器可达的
# 宿主机地址（compose 网关 IP），返回的图片 URL 也要能被浏览器取到——同一
# 网关地址两者皆可达。
GW=$(docker network inspect supabase-stack_default \
  --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)
cat > /tmp/e2e-configs.sql <<SQL
create table if not exists public.configs (key text primary key, value text not null);
insert into public.configs (key, value) values
  ('NEWAPI_URL', 'http://${GW}:9999'),
  ('NEWAPI_KEY', 'sk-mock-e2e')
on conflict (key) do update set value = excluded.value;
SQL
apply_sql /tmp/e2e-configs.sql >/dev/null 2>&1 || true
export MOCK_GW="$GW"
python3 - <<'PYMOCK' &
import struct, zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

def png():
    w = h = 64; rgb = (120, 160, 200)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

IMG = png()

class Handler(BaseHTTPRequestHandler):
    def _send(self, ctype, body):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send("image/png", IMG)

    def do_POST(self):
        import json, os
        gw = os.environ.get("MOCK_GW", "127.0.0.1")
        # 返回 ai-outputs 公开桶直链：与生产"归档后"的最终形态一致，
        # canvas-URL 用例断言的就是 /object/public/ai-outputs/ 模式
        body = json.dumps({"created": 1, "data": [
            {"url": "http://127.0.0.1:8021/storage/v1/object/public/ai-outputs/e2e/mock-gen.png"}]}).encode()
        self._send("application/json", body)

    def log_message(self, *args):
        pass

HTTPServer(("0.0.0.0", 9999), Handler).serve_forever()
PYMOCK
MOCK_PID=$!
trap 'kill ${MOCK_PID} 2>/dev/null || true' EXIT
sleep 0.5
curl -sf "http://127.0.0.1:9999/mock-image.png" -o /dev/null \
  && echo "  · mock 生图上游就绪（${GW}:9999，配额走 consume_image_quota 默认 200/月）" \
  || echo "  ⚠ mock 上游未就绪，canvas-URL 用例将失败（不阻塞其余用例）"

echo "[e2e] ④ 安装依赖与 Playwright（--with-deps 自装系统包与浏览器）"
corepack enable --install-directory "$HOME/.local/bin" 2>/dev/null || corepack enable
export PATH="$HOME/.local/bin:$PATH"
corepack prepare "pnpm@${PNPM_VERSION:?PNPM_VERSION 未透传}" --activate
pnpm config set store-dir .pnpm-store
pnpm install --frozen-lockfile
sudo -E env "PATH=$PATH" pnpm exec playwright install --with-deps chromium

echo "[e2e] ⑤ 运行 E2E（${E2E_ARGS}；webServer=preview 生产产物模式）"
# 生产产物模式（nx build web + vite preview）：dev server 在 2 核冷机上编译
# model-viewer 等懒块会突破用例等待窗（glb 预览两用例即因此降级失败）
export E2E_WEB_SERVER="${E2E_WEB_SERVER:-preview}"
# 慢环境标记：模型初始化/编码类用例据此放宽用例级超时（如以图搜图 60s→180s）
export E2E_SLOW_ENV=1
export VITE_SUPABASE_URL="$STACK_URL"
export VITE_SUPABASE_ANON_KEY="$ANON_KEY"
export E2E_SUPABASE_URL="$STACK_URL"
export E2E_SUPABASE_ANON_KEY="$ANON_KEY"
export E2E_SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE"
export E2E_TEST_PASSWORD="$PW"
# 测试失败也要先收集报告再退出（失败轮的 error-context 是唯一的诊断来源）
E2E_RC=0
if [ -n "$E2E_ARGS" ]; then
  pnpm exec nx e2e web-e2e -- $E2E_ARGS || E2E_RC=$?
else
  pnpm exec nx e2e web-e2e || E2E_RC=$?
fi

echo "[e2e] ⑥ 收集报告进 dist/（e2e 退出码 ${E2E_RC}）"
mkdir -p dist
cp -r apps/web-e2e/playwright-report dist/ 2>/dev/null || true
cp -r apps/web-e2e/test-results dist/ 2>/dev/null || true
echo "[e2e] 完成（e2e 退出码 ${E2E_RC}）"
exit "$E2E_RC"
