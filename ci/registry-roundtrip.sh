#!/usr/bin/env bash
# ci/registry-roundtrip.sh — 桥接产物回传链路的读端验证（smoke 作业在 bridge.sh
# 成功后调用）：用 CI_JOB_TOKEN 从 generic package registry 下载刚回传的
# dist tgz 并校验 tar 结构。tauri-package-macos-arm64 的 MACOS_FETCH_ARTIFACTS
# 还原路径依赖这条 Job-Token 认证，此处常驻守护（失效会在每次 push 的 smoke
# 立刻暴露，而不是等到下次发版打包才炸）。
set -euo pipefail

CORR="gl${CI_PROJECT_ID:?}-p${CI_PIPELINE_ID:?}j${CI_JOB_ID:?}"
# 包名按平台分（与 ci/bridge.sh 的 BRIDGE_KIND 一致，默认 macos-bridge 兼容存量）
PKG_NAME="${BRIDGE_KIND:-macos}-bridge"
URL="https://${CI_SERVER_HOST:?}/api/v4/projects/${CI_PROJECT_ID}/packages/generic/${PKG_NAME}/${CORR}/${CORR}.tgz"
# CI_SERVER_HOST 不含端口（非标端口实例），与 ci/bridge.sh 同规则拼接
if [ "${CI_SERVER_PORT:-443}" != "443" ]; then
  URL="https://${CI_SERVER_HOST}:${CI_SERVER_PORT}/api/v4/projects/${CI_PROJECT_ID}/packages/generic/${PKG_NAME}/${CORR}/${CORR}.tgz"
fi

echo "roundtrip: GET ${URL}"
curl -sS --fail --max-time 300 -H "Job-Token: ${CI_JOB_TOKEN:?}" -o /tmp/roundtrip.tgz "$URL" \
  || { echo "roundtrip: ✗ Job-Token 下载失败（MACOS_FETCH_ARTIFACTS 还原路径将不可用）" >&2; exit 1; }

# smoke 的 dist/ 只有一个文件，校验 tar 根目录是 dist/
root=$(tar -tzf /tmp/roundtrip.tgz | head -1)
case "$root" in
  dist/*) echo "roundtrip: ✓ Job-Token 下载 + tar 结构 OK（${root}）" ;;
  *) echo "roundtrip: ✗ 意外的 tar 根目录：${root}" >&2; exit 1 ;;
esac
rm -f /tmp/roundtrip.tgz
