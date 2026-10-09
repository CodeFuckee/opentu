#!/usr/bin/env bash
# segment-server 部署脚本(在宿主机 10.0.0.220 上执行,2026-10 迁移自 10.37.80.25)
#
# 用法: ssh mdc@10.0.0.220 'bash -s' < scripts/deploy-segment-server.sh(SSH 免密需按新 IP 重配)
#
# 职责:
#   1. 确保权重存在(缺失则从 fbaipublicfiles 直链下载,无 gate)
#   2. 构建镜像(仓库需先同步到 /home/mdc/codes/segment-server/repo)
#   3. 重建容器:GPU device 0、显存软限由服务内 SEG_MEM_FRACTION 控制、
#      --memory 12g 兜底、接入 supabase_default 网络(不发布端口,
#      仅 edge function 容器可按名 segment-server 访问)
#   4. 健康检查(/health 返回 device)
set -euo pipefail

ROOT=/home/mdc/codes/segment-server
REPO_SRC=${ROOT}/repo/services/segment-server
MODELS=${ROOT}/models
CKPT=${MODELS}/sam2.1_hiera_large.pt
CONTAINER=segment-server

mkdir -p "${MODELS}"

if [ ! -s "${CKPT}" ]; then
  echo "[deploy] 下载 sam2.1_hiera_large.pt(~898MB,无 gate)..."
  curl -fL --retry 3 -o "${CKPT}" \
    "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"
fi

echo "[deploy] 构建镜像..."
docker build -t segment-server:latest "${REPO_SRC}"

echo "[deploy] 重建容器(仅 supabase_default 网内可达,不发布端口)..."
docker rm -f "${CONTAINER}" 2>/dev/null || true
# 基底镜像自带 HEALTHCHECK 指向原应用端口会误报 unhealthy,覆盖为本服务 /health
HC='import urllib.request;urllib.request.urlopen("http://127.0.0.1:8300/health",timeout=3)'
docker run -d \
  --name "${CONTAINER}" \
  --restart unless-stopped \
  --gpus '"device=0"' \
  --memory=12g \
  --network supabase_default \
  --health-cmd "python -c '${HC}'" \
  --health-interval 30s \
  --health-timeout 5s \
  --health-retries 3 \
  -v "${MODELS}":/models:ro \
  segment-server:latest

echo "[deploy] 等待健康检查(模型加载约需 5-20s)..."
for i in $(seq 1 30); do
  if docker exec "${CONTAINER}" python -c "${HC};print('ok')" 2>/dev/null; then
    echo "[deploy] 上线成功"
    exit 0
  fi
  sleep 2
done

echo "[deploy] 健康检查超时,最近日志:"
docker logs --tail 30 "${CONTAINER}"
exit 1
