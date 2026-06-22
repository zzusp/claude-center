# syntax=docker/dockerfile:1.7
# Console 镜像（Next.js standalone）。多阶段：
#   deps  → 在 workspace 根装依赖（npm workspaces 会自动把 console / db / relay-client 串起来）
#   build → 编译 db / relay-client（tsc）+ next build（生成 .next/standalone）
#   run   → 只拷 standalone + .next/static + public，跑 node server.js
# 上下文：docker compose build 时 context 指向仓库根（不是 apps/console/），否则拷不到 workspace。

ARG NODE_VERSION=22-alpine

# ─────────────────────────────── deps ───────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
# 只拷 manifest 利用 BuildKit layer cache：源码变更不会让 npm ci 失效。
COPY package.json package-lock.json ./
COPY apps/console/package.json apps/console/package.json
COPY apps/relay/package.json    apps/relay/package.json
COPY apps/worker/package.json   apps/worker/package.json
COPY packages/db/package.json   packages/db/package.json
COPY packages/relay-client/package.json packages/relay-client/package.json
# --ignore-scripts 防 electron(workspace 里 worker 的 devDep) 在 alpine 拉 chromium。
# 同 image 不构建 worker，只要它的 package.json 不会触发 postinstall 即可。
RUN npm ci --ignore-scripts

# ─────────────────────────────── build ──────────────────────────────
FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build args：CI 把 cc tag 去前缀后传进来。dev 本地 build 不传 → 默认 "dev"，next 把它编进客户端 bundle。
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV APP_VERSION_BUILT_AT=
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm -w @claude-center/db run build \
 && npm -w @claude-center/relay-client run build \
 && npm -w @claude-center/console run build

# ─────────────────────────────── run ────────────────────────────────
FROM node:${NODE_VERSION} AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# 非 root 用户。
RUN addgroup -S app && adduser -S app -G app
# standalone 目录结构：app/apps/console/server.js + app/node_modules（顶层）+ app/apps/console/.next/...
COPY --from=build --chown=app:app /app/apps/console/.next/standalone ./
COPY --from=build --chown=app:app /app/apps/console/.next/static     ./apps/console/.next/static
# 注意：apps/console/public/ 在仓库里不存在（本项目无静态资产），故不拷。
# 如果未来加了静态文件，新建 apps/console/public/ 并放进去，把这行解开：
# COPY --from=build --chown=app:app /app/apps/console/public         ./apps/console/public

# instrumentation-node.ts 用 `webpackIgnore: true` 动态 import "@claude-center/db"（避免编译期把
# pg 的 fs 拖进 edge runtime），Next standalone trace 看不到这条 import 所以不拷 workspace 包。
# 手动补 packages 目录 + 重建 workspace symlink，让运行时 require resolve 找得到。
COPY --from=build --chown=app:app /app/packages/db/dist                   ./packages/db/dist
COPY --from=build --chown=app:app /app/packages/db/package.json           ./packages/db/package.json
COPY --from=build --chown=app:app /app/packages/relay-client/dist         ./packages/relay-client/dist
COPY --from=build --chown=app:app /app/packages/relay-client/package.json ./packages/relay-client/package.json
RUN mkdir -p node_modules/@claude-center && \
    ln -s ../../packages/db           node_modules/@claude-center/db && \
    ln -s ../../packages/relay-client node_modules/@claude-center/relay-client && \
    chown -R app:app node_modules/@claude-center packages

USER app
EXPOSE 3000
# 健康检查走 /api/dashboard：未登录 401 也算服务在线（curl 默认对 4xx 不返回非零，加 --fail-with-body 在 ≥400 才红，
# 我们要的是「能响应即在线」→ 不加 --fail，只看 connect 是否成功）。
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null --tries=1 --timeout=3 "http://127.0.0.1:3000/api/dashboard" || exit 1
CMD ["node", "apps/console/server.js"]
