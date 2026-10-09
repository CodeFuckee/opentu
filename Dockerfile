FROM node:20 AS builder

WORKDIR /builder

COPY . /builder

# 前端 Supabase 网关为构建期内联(导入期常量)。缺省不传 → 使用仓库内 fallback
# (生产地址 10.37.80.25);预览等开发环境部署时用
# --build-arg VITE_SUPABASE_URL=http://10.0.0.220:8021 注入开发网关
ARG VITE_SUPABASE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL

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
