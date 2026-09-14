FROM node:20 AS builder

WORKDIR /builder

COPY . /builder

RUN corepack enable pnpm \
    && pnpm install --frozen-lockfile \
    # docker 镜像自托管部署：入口资源保持同源（不开 CDN 改写），否则
    # index.html 会引用 cdn.jsdelivr.net/npm/aitu-app@<version>/...，
    # 而 npm 未发布对应版本时 404，应用加载卡在进度条（此前部署即卡 82%）
    && AITU_REWRITE_ENTRY_ASSETS_TO_CDN=0 pnpm build


FROM lipanski/docker-static-website:2.4.0

WORKDIR /home/static

COPY --from=builder /builder/dist/apps/web/ /home/static

EXPOSE 80

# -c httpd.conf 移除：仓库与构建产物中均无该文件（busybox 实际以默认配置运行，
# 引用不存在的配置只具误导性）
CMD ["/busybox-httpd", "-f", "-v", "-p", "80"]
