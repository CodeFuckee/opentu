#!/usr/bin/env bash
# yue-image MCP 服务器部署脚本（目标宿主机 mdc@10.0.0.220，与 segment-server 同模式）
#
# 用法（本机执行，SSH 免密）：
#   ssh mdc@10.0.0.220 'bash -s' < scripts/deploy-image-mcp-server.sh
#
# 前提（宿主机一次性准备）：
#   1. 仓库已同步到 /home/mdc/codes/image-mcp-server/repo
#      （本机：rsync -a --delete --exclude node_modules services/mcp-server/ mdc@10.0.0.220:/home/mdc/codes/image-mcp-server/repo/ 之外的
#       完整仓库同步方式见 README；脚本只要求 repo/services/mcp-server 存在）
#   2. 凭据 env 文件 ~/image-mcp.env（0600，账号本人填写，勿入库）：
#        SUPABASE_URL=http://10.0.0.220:8021
#        SUPABASE_ANON_KEY=<supabase 栈 .env 的 ANON_KEY>
#        SUPABASE_EMAIL=<生图账号邮箱>
#        SUPABASE_PASSWORD=<生图账号密码>
#        MCP_AUTH_TOKEN=<自生成的随机 token（agent 注册用同一值）>
#      ANON_KEY 缺省时脚本会尝试从 supabase 栈 env 自动提取。
#
# 职责：
#   1. 校验 env 文件存在与关键字段齐全（ANON_KEY 可自动提取）
#   2. 构建镜像（Docker Hub 不通时用镜像源前缀拉 node:20-alpine）
#   3. 重建容器：发布 8301 端口（LAN 内 agent 可达）、--restart unless-stopped
#   4. /health 健康检查
set -euo pipefail

ROOT=/home/mdc/codes/image-mcp-server
REPO_SRC=${ROOT}/repo/services/mcp-server
ENV_FILE=${HOME}/image-mcp.env
CONTAINER=yue-image-mcp
PORT=8301

if [ ! -d "${REPO_SRC}/src" ]; then
  echo "[deploy] 缺少 ${REPO_SRC}/src——先把仓库 services/mcp-server 同步过去"
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "[deploy] 缺少凭据文件 ${ENV_FILE}（0600，模板见脚本头注释），由账号本人填写"
  exit 1
fi

chmod 600 "${ENV_FILE}"
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

missing=()
[ -z "${SUPABASE_URL:-}" ] && missing+=("SUPABASE_URL")
[ -z "${SUPABASE_EMAIL:-}" ] && missing+=("SUPABASE_EMAIL")
[ -z "${SUPABASE_PASSWORD:-}" ] && missing+=("SUPABASE_PASSWORD")
[ -z "${MCP_AUTH_TOKEN:-}" ] && missing+=("MCP_AUTH_TOKEN")
if [ ${#missing[@]} -gt 0 ]; then
  echo "[deploy] ${ENV_FILE} 缺少字段: ${missing[*]}"
  exit 1
fi

# ANON_KEY 未填时从 supabase 栈 env 自动提取（anon key 非机密，随 SPA 分发）
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  STACK_ENV=${HOME}/codes/supabase/.env
  if [ -f "${STACK_ENV}" ]; then
    SUPABASE_ANON_KEY=$(grep -E '^ANON_KEY=' "${STACK_ENV}" | head -1 | cut -d= -f2- | tr -d '"' || true)
  fi
  if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
    echo "[deploy] SUPABASE_ANON_KEY 未填写且无法从 ${STACK_ENV} 自动提取"
    exit 1
  fi
  echo "[deploy] 已从 supabase 栈 env 自动提取 ANON_KEY"
fi

# 生成容器运行用 env（把补齐的 ANON_KEY 也带上）
RUN_ENV=${ROOT}/run.env
umask 177
cat > "${RUN_ENV}" <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_EMAIL=${SUPABASE_EMAIL}
SUPABASE_PASSWORD=${SUPABASE_PASSWORD}
MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN}
EOF
umask 022

echo "[deploy] 构建镜像..."
BASE_IMAGE=node:20-alpine
if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  if ! docker pull "${BASE_IMAGE}" >/dev/null 2>&1; then
    # 宿主机 Docker Hub 不通：library 镜像走镜像源（2026-11 实证可用）
    BASE_IMAGE=docker.1ms.run/node:20-alpine
    docker pull "${BASE_IMAGE}"
  fi
fi
docker build --build-arg BASE_IMAGE="${BASE_IMAGE}" -t yue-image-mcp:latest "${REPO_SRC}"

echo "[deploy] 重建容器（发布 ${PORT}，LAN 内 agent 可达）..."
docker rm -f "${CONTAINER}" 2>/dev/null || true
docker run -d \
  --name "${CONTAINER}" \
  --restart unless-stopped \
  --env-file "${RUN_ENV}" \
  -p "${PORT}:8301" \
  yue-image-mcp:latest

echo "[deploy] 等待健康检查..."
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "[deploy] 上线成功: http://10.0.0.220:${PORT}/mcp"
    curl -fsS "http://127.0.0.1:${PORT}/health"
    echo
    exit 0
  fi
  sleep 2
done

echo "[deploy] 健康检查超时，最近日志:"
docker logs --tail 30 "${CONTAINER}"
exit 1
