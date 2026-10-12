#!/usr/bin/env bash
# ci/bridge.sh — 把当前 GitLab 作业桥接到 GitHub Actions 托管 runner 上执行
# （多平台：BRIDGE_KIND=macos|linux，桥接仓库据此路由 runner 标签）。
#
# 用法：在 .gitlab-ci.yml 里定义一个跑在任意可用 GitLab runner 上的作业，
#   variables 里指定 MACOS_SCRIPT/BRIDGE_SCRIPT=（仓库内脚本路径），script 调本脚本。
#   脚本必须自包含（自己装依赖、构建），产出物放 dist/，会由 GitHub 侧自动
#   PUT 回本项目的 generic package registry（包名 <kind>-bridge，版本号 = correlation_id）。
#
# 依赖：bash、curl、python3（Ubuntu 22.04 runner 自带；刻意不依赖 jq）。
# 环境变量：
#   GH_BRIDGE_REPO      (必填) GitHub 桥接仓库 owner/repo，如 CodeFuckee/gl-macos-bridge
#   GH_BRIDGE_TOKEN     (必填) 对该仓库有 contents:write 的 GitHub PAT
#                        （GitLab 项目级 masked+protected CI 变量）
#   MACOS_SCRIPT        (必填*) 要在目标平台执行的脚本（本仓库内路径；历史命名）
#   BRIDGE_SCRIPT       (必填*二选一) 同上，新命名
#   BRIDGE_KIND         (可选，默认 macos) 平台枚举 macos|linux
#   MACOS_EXTRA_ENV     (可选) 附带传给目标平台的变量 "K1=V1 K2=V2"（值不含空格）
#   MACOS_ENV_PASSTHROUGH (可选) 按名整值透传 GitLab 变量（值可含空格；只放非敏感配置）
#   MACOS_FETCH_ARTIFACTS (可选，默认 false) true 时成功后拉回产物还原 target/... 原路径
#   GH_POLL_INTERVAL    (可选，默认 15) 轮询间隔秒
#   GH_POLL_TIMEOUT_MIN (可选，默认 40) 等待 GitHub run 的分钟上限，须小于作业 timeout
#
# 原理：组装 payload（脚本 base64 + 白名单 CI 变量）→ POST repository_dispatch
#   → 按 run-name 后缀（correlation_id）轮询终态 → 镜像为退出码；
#   本作业被取消时 trap 会同步取消 GitHub 侧 run。
# 安全：payload 不携带任何凭据；GH_BRIDGE_TOKEN 是 masked 变量，本脚本不回显。
set -euo pipefail

fail() { echo "bridge: $*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail "runner 缺 curl"
command -v python3 >/dev/null 2>&1 || fail "runner 缺 python3（本脚本刻意不依赖 jq）"

GH_BRIDGE_REPO="${GH_BRIDGE_REPO:?GH_BRIDGE_REPO 未设置}"
GH_BRIDGE_TOKEN="${GH_BRIDGE_TOKEN:?GH_BRIDGE_TOKEN 未设置（见 docs/ci/macos-bridge.md）}"
BRIDGE_KIND="${BRIDGE_KIND:-macos}"
case "$BRIDGE_KIND" in macos|linux) ;; *) fail "BRIDGE_KIND 非法: $BRIDGE_KIND（只允许 macos|linux）" ;; esac
PKG_NAME="${BRIDGE_KIND}-bridge"
MACOS_SCRIPT="${BRIDGE_SCRIPT:-${MACOS_SCRIPT:-}}"
MACOS_SCRIPT="${MACOS_SCRIPT:?MACOS_SCRIPT/BRIDGE_SCRIPT 未设置}"
[ -f "$MACOS_SCRIPT" ] || fail "脚本不存在: $MACOS_SCRIPT"

CORR="gl${CI_PROJECT_ID}-p${CI_PIPELINE_ID}j${CI_JOB_ID}"
INTERVAL="${GH_POLL_INTERVAL:-15}"
DEADLINE=$(( $(date +%s) + ${GH_POLL_TIMEOUT_MIN:-40} * 60 ))
API="https://api.github.com/repos/${GH_BRIDGE_REPO}"
# CI_SERVER_HOST 不含端口：非标端口实例须拼 CI_SERVER_PORT（与 payload 构造保持一致）
if [ "${CI_SERVER_PORT:-443}" = "443" ]; then
  GL_SERVER="${CI_SERVER_HOST}"
else
  GL_SERVER="${CI_SERVER_HOST}:${CI_SERVER_PORT}"
fi

gh_curl() {
  curl -sS -m 30 \
    -H "Authorization: Bearer ${GH_BRIDGE_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# 从 run 列表里按 run-name 后缀=correlation_id 定位本次 run：id status conclusion url
find_run() {
  gh_curl "${API}/actions/runs?event=repository_dispatch&per_page=30" | python3 -c '
import json, sys
corr = sys.argv[1]
try:
    runs = json.load(sys.stdin).get("workflow_runs", [])
except Exception:
    sys.exit(0)
for r in runs:
    if r.get("name", "").endswith(corr):
        print(r["id"], r["status"], r["conclusion"] or "-", r["html_url"])
        break
' "$CORR"
}

cancel_run() {
  local out rid
  out=$(find_run 2>/dev/null || true)
  rid=$(awk '{print $1}' <<<"${out:-}")
  if [ -n "$rid" ]; then
    echo "bridge: 取消 GitHub run ${rid}"
    gh_curl -X POST "${API}/actions/runs/${rid}/cancel" >/dev/null 2>&1 || true
  fi
}
trap cancel_run EXIT

# ---- ① 组装 payload（python3 保证 JSON 转义正确）----
PAYLOAD=$(python3 - <<'PY'
import base64, json, os

def env(k, d=""):
    return os.environ.get(k, d)

# CI_SERVER_HOST 不含端口（非标端口实例必须拼上 CI_SERVER_PORT，否则
# GitHub 侧克隆/回传会打到 443 上 404——首条真实流水线实测踩坑）
host = env("CI_SERVER_HOST")
port = env("CI_SERVER_PORT", "443")
server = host if port == "443" else f"{host}:{port}"

env_whitelist = {
    "CI_PROJECT_PATH": env("CI_PROJECT_PATH"),
    "CI_PROJECT_NAME": env("CI_PROJECT_NAME"),
    "CI_COMMIT_REF_NAME": env("CI_COMMIT_REF_NAME"),
    "CI_COMMIT_SHA": env("CI_COMMIT_SHA"),
    "CI_PIPELINE_IID": env("CI_PIPELINE_IID"),
    "CI_JOB_NAME": env("CI_JOB_NAME"),
    # 传修正后的带端口地址，macOS 侧脚本用它拼 URL
    "CI_SERVER_HOST": server,
}
# MACOS_EXTRA_ENV="K1=V1 K2=V2"（值不含空格；复杂需求改此处白名单）
for kv in os.environ.get("MACOS_EXTRA_ENV", "").split():
    if "=" in kv:
        k, _, v = kv.partition("=")
        env_whitelist[k] = v

# MACOS_ENV_PASSTHROUGH="NAME1 NAME2"：按名字整值透传 GitLab 变量（值可含空格，
# 补 MACOS_EXTRA_ENV 的空白切分短板）。只允许透传非敏感构建配置（RUST_VERSION/
# RUSTFLAGS 等）；密钥类变量绝不进 payload——payload 是公开数据，签名密钥走
# GitHub secrets（GL131_ 前缀）由 workflow 注入 macOS 环境
for _name in os.environ.get("MACOS_ENV_PASSTHROUGH", "").split():
    if _name in os.environ:
        env_whitelist[_name] = os.environ[_name]

payload = {
    "correlation_id": "gl{pid}-p{pl}j{jb}".format(
        pid=env("CI_PROJECT_ID"), pl=env("CI_PIPELINE_ID"), jb=env("CI_JOB_ID")),
    # GitHub repository_dispatch 的 client_payload 顶层属性上限 10 个：
    # GitLab 上下文收进嵌套对象（嵌套算 1 个属性），顶层固定 4 个。
    "gl": {
        "server": server,
        "project": env("CI_PROJECT_PATH"),
        "project_id": env("CI_PROJECT_ID"),
        "ref": env("CI_COMMIT_REF_NAME"),
        "sha": env("CI_COMMIT_SHA"),
        "pipeline": env("CI_PIPELINE_ID"),
        "job": env("CI_JOB_ID"),
        "job_name": env("CI_JOB_NAME"),
    },
    "env": env_whitelist,
    # 平台枚举：桥接仓库 resolve 据此在 allowlist runners 里挑标签（白名单校验后
    # 才流入 runs-on，结构字段不动态拼）
    "kind": os.environ.get("BRIDGE_KIND", "macos"),
    "script_b64": base64.b64encode(open(os.environ["MACOS_SCRIPT"], "rb").read()).decode(),
}
print(json.dumps(payload))
PY
) || fail "payload 组装失败"

# ---- ② 触发 repository_dispatch ----
echo "bridge: dispatch → ${GH_BRIDGE_REPO}（corr=${CORR}）"
gh_curl -f -X POST "${API}/dispatches" \
  -d "{\"event_type\":\"gl-macos-job\",\"client_payload\":${PAYLOAD}}" >/dev/null \
  || fail "repository_dispatch 失败：检查 GH_BRIDGE_REPO 名称、GH_BRIDGE_TOKEN 权限（需 contents:write）与有效期"

# ---- ③ 轮询终态并镜像 ----
echo "bridge: 轮询 GitHub run（每 ${INTERVAL}s，上限 ${GH_POLL_TIMEOUT_MIN:-40} 分钟）"
while :; do
  out=$(find_run || true)
  if [ -n "${out:-}" ]; then
    read -r rid state concl url <<<"$out"
    echo "  GitHub run ${rid}: ${state}/${concl}  ${url}"
    if [ "$state" = "completed" ]; then
      trap - EXIT
      if [ "$concl" = "success" ]; then
        echo "bridge: ✓ macOS 作业成功；产物（如有）已回传 package registry："
        echo "  https://${GL_SERVER}/api/v4/projects/${CI_PROJECT_ID}/packages/generic/${PKG_NAME}/${CORR}/${CORR}.tgz"
        # BRIDGE_COVERAGE=true 时从 run 日志抓覆盖率 TOTAL 行回显到本作业日志——
        # GitLab 的 coverage 正则只扫 GitLab 侧 trace，llvm-cov 的输出在 GitHub 侧，
        # 不取回则流水线覆盖率指标停止更新（脚本输出在目标平台日志里）
        if [ "${BRIDGE_COVERAGE:-false}" = "true" ]; then
          gj=$(gh_curl "${API}/actions/runs/${rid}/jobs" | python3 -c '
import json, sys
jobs = json.load(sys.stdin).get("jobs", [])
run_jobs = [j["id"] for j in jobs if j.get("name") == "run"]
print(run_jobs[0] if run_jobs else (jobs[0]["id"] if jobs else ""))') || gj=""
          if [ -n "$gj" ]; then
            # 原始 job 日志每行带 runner 时间戳前缀，匹配后剥掉再回显
            gh_curl -L "${API}/actions/jobs/${gj}/logs" \
              | grep -aoE "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z TOTAL.*" \
              | sed -E 's/^[0-9T:.Z-]+Z //' || true
          fi
        fi
        # MACOS_FETCH_ARTIFACTS=true 时拉回产物并按仓库相对路径还原
        # （macOS 脚本把产物镜像进 dist/target/...，解包 strip dist/ 后即恢复
        # target/... 原路径，下游 GitLab artifacts/publish 的 glob 零改动）
        if [ "${MACOS_FETCH_ARTIFACTS:-false}" = "true" ]; then
          ART_URL="https://${GL_SERVER}/api/v4/projects/${CI_PROJECT_ID}/packages/generic/${PKG_NAME}/${CORR}/${CORR}.tgz"
          echo "bridge: 拉回 macOS 产物 → ${CI_PROJECT_DIR}"
          # 每作业唯一临时路径：shell runner 同机并发多个桥接作业（如夜间流水线
          # build-release-macos 与 package-daily-macos-arm64 同段并发）共用固定
          # /tmp 路径会互写覆盖——先完成者的完整 gzip 流 + 后者已写出的中间段，
          # 恰好构成「decompression OK + trailing garbage」（3828 两连败根因，
          # registry 里的文件经逐字节核验是干净的，损坏只发生在本机下载产物上）
          TGZ="/tmp/bridge-artifacts.${CI_JOB_ID}.tgz"
          if ! curl -sS --fail --max-time 1800 -H "Job-Token: ${CI_JOB_TOKEN}" \
              -o "$TGZ" "$ART_URL"; then
            # Job-Token 下载失败时回退项目内 read_api token（updater 下载用）
            [ -n "${WORK_REVIEW_UPDATER_GITLAB_TOKEN:-}" ] \
              || fail "产物下载失败且无 WORK_REVIEW_UPDATER_GITLAB_TOKEN 可回退: $ART_URL"
            curl -sS --fail --max-time 1800 -H "PRIVATE-TOKEN: ${WORK_REVIEW_UPDATER_GITLAB_TOKEN}" \
              -o "$TGZ" "$ART_URL" || fail "产物下载失败: $ART_URL"
          fi
          tar -tzf "$TGZ" | sed 's/^dist\///' | sed 's/^/  还原: /'
          tar -xzf "$TGZ" -C "$CI_PROJECT_DIR" --strip-components=1
          rm -f "$TGZ"
        fi
        exit 0
      fi
      echo "bridge: ✗ macOS 作业失败（${concl}），日志：${url}" >&2
      exit 1
    fi
  fi
  [ "$(date +%s)" -gt "$DEADLINE" ] && fail "等待 GitHub run 超时（run 可能仍在排队/执行）"
  sleep "$INTERVAL"
done
