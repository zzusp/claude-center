# syntax=docker/dockerfile:1.7
# Relay 镜像（独立 Node 服务）。relay 自身无第三方 npm 依赖（只用 node: 内置 + 同仓 relay-client），
# 多阶段：deps → build → run（拷必要的 dist 与软链）。上下文：仓库根。

ARG NODE_VERSION=22-alpine

# ─────────────────────────────── deps ───────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/console/package.json apps/console/package.json
COPY apps/relay/package.json    apps/relay/package.json
COPY apps/worker/package.json   apps/worker/package.json
COPY packages/db/package.json   packages/db/package.json
COPY packages/relay-client/package.json packages/relay-client/package.json
# --ignore-scripts 防 electron(worker devDep) 在 alpine 拉 chromium 卡 build。
RUN npm ci --ignore-scripts

# ─────────────────────────────── build ──────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm -w @claude-center/relay-client run build \
 && npm -w @claude-center/relay run build

# ─────────────────────────────── run ────────────────────────────────
FROM node:${NODE_VERSION} AS run
WORKDIR /app
ENV NODE_ENV=production
ENV CLAUDE_CENTER_RELAY_HOST=0.0.0.0
ENV CLAUDE_CENTER_RELAY_PORT=8787
RUN addgroup -S app && adduser -S app -G app
# relay 运行只需：dist + relay-client/dist + 顶层 node_modules 的 workspace 链接。
# 整个 node_modules 体积有限（无 next/react），直接拷过来最稳。
COPY --from=build --chown=app:app /app/apps/relay/dist                  apps/relay/dist
COPY --from=build --chown=app:app /app/apps/relay/package.json          apps/relay/package.json
COPY --from=build --chown=app:app /app/packages/relay-client/dist       packages/relay-client/dist
COPY --from=build --chown=app:app /app/packages/relay-client/package.json packages/relay-client/package.json
COPY --from=build --chown=app:app /app/node_modules/@claude-center      node_modules/@claude-center
USER app
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null --tries=1 --timeout=3 "http://127.0.0.1:8787/healthz" || exit 1
CMD ["node", "apps/relay/dist/main.js"]
