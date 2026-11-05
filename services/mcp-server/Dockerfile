# Yu画布生图 MCP 服务器
# 部署宿主机（mdc@10.0.0.220）Docker Hub 不通：library 镜像经镜像源可拉，
# 部署脚本会用 --build-arg BASE_IMAGE 注入镜像源前缀（如 docker.1ms.run/node:20-alpine）
ARG BASE_IMAGE=node:20-alpine
FROM ${BASE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./
# 生产仅装运行时依赖；镜像源由部署环境自行决定（构建参数 NPM_REGISTRY 可覆盖）
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --registry=${NPM_REGISTRY}

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8301

# wget 来自 busybox（alpine 自带），无鉴权健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8301/health || exit 1

CMD ["node", "src/server.js"]
