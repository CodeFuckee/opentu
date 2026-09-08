# =============================================================
# Feedbackland 自托管镜像（多阶段构建）
# 认证已改造为 Supabase Auth；产物包含 feedbackland-react workspace。
# NEXT_PUBLIC_* 是构建期内联变量，必须通过 --build-arg 传入；
# 运行期变量（DATABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENROUTER_API_KEY）
# 由 docker compose environment 注入。
# =============================================================

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY feedbackland-react/package.json feedbackland-react/package.json
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SELF_HOSTED=true
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SELF_HOSTED=$NEXT_PUBLIC_SELF_HOSTED
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# build 会先生成 feedbackland-react/dist，再执行 next build
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat && \
    addgroup -S nodejs && adduser -S nextjs -G nodejs && \
    mkdir -p /app/.next && chown -R nextjs:nodejs /app

COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/feedbackland-react ./feedbackland-react
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000
CMD ["npx", "next", "start"]
