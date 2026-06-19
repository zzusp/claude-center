#!/usr/bin/env bash
# 在服务器上执行的部署脚本。被 .github/workflows/deploy-web.yml 通过 SSH 调起。
# 也可手动运行：sudo bash deploy-on-server.sh 0.2.0 /tmp/cc-deploy-0.2.0.tar.gz
#
# 关键设计：服务器**不依赖** GitHub 出站连通（国内服务器对 github.com:443 普遍不通）。
# 部署源是 CI runner 在境外 checkout 后打包、scp 上来的 release bundle（tarball）。
#
# 假设：
#   - /opt/claude-center/.env 存在（含 DATABASE_URL 等），权限 600（一次性 bootstrap 时放好）；
#   - 宿主机已装 docker + docker compose v2；
#   - postgres 跑在宿主机 :55432（compose 内服务通过 host.docker.internal 走 host-gateway 访问）。
set -Eeuo pipefail

APP_VERSION="${1:-${APP_VERSION:-}}"
BUNDLE="${2:-${BUNDLE:-/tmp/cc-deploy-${APP_VERSION}.tar.gz}}"

if [[ -z "$APP_VERSION" ]]; then
  echo "[deploy] 用法：bash deploy-on-server.sh <X.Y.Z> [bundle.tar.gz]"
  exit 2
fi
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[deploy] APP_VERSION 格式错误（应为 X.Y.Z）：$APP_VERSION"
  exit 2
fi
if [[ ! -f "$BUNDLE" ]]; then
  echo "[deploy] 缺 release bundle：$BUNDLE"
  echo "[deploy] CI 会 scp 上来；手工部署需先把 tarball 放到该路径。"
  exit 2
fi

APP_DIR="${APP_DIR:-/opt/claude-center}"
TAG="cc-v${APP_VERSION}"

echo "[deploy] === $TAG → $APP_DIR (bundle=$BUNDLE) ==="

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "[deploy] 缺 $APP_DIR/.env（含 DATABASE_URL 等），先一次性 bootstrap。"
  exit 1
fi

# 1) 解压到临时区。tar 内容布局兼容两种：根目录直接是仓库内容 / 多一层 wrapper 目录。
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$BUNDLE" -C "$stage"
src="$stage"
if [[ ! -f "$src/docker-compose.yml" ]]; then
  wrap=$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [[ -n "$wrap" && -f "$wrap/docker-compose.yml" ]]; then
    src="$wrap"
  else
    echo "[deploy] bundle 解压后找不到 docker-compose.yml"
    ls -la "$stage"
    exit 1
  fi
fi

# 2) rsync 替换 APP_DIR（保留 .env，删多余文件）
rsync -a --delete --exclude='.env' "$src/" "$APP_DIR/"

cd "$APP_DIR"
chmod 600 .env || true

# 3) docker compose build/up
export APP_VERSION

echo "[deploy] docker compose build console relay (APP_VERSION=$APP_VERSION)"
docker compose build console relay

echo "[deploy] docker compose up -d console relay"
docker compose up -d console relay

# 4) 健康检查
echo "[deploy] 等待 console 就绪（最多 60s）"
last_code=000
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:3000/api/auth/me || echo 000)
  last_code="$code"
  if [[ "$code" == "200" || "$code" == "401" ]]; then
    echo "[deploy] console OK (HTTP $code)"
    break
  fi
  if [[ $i -eq 12 ]]; then
    echo "[deploy] console 未就绪（最后 HTTP $code）"
    docker compose logs --tail=80 console
    exit 1
  fi
  sleep 5
done

code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8787/healthz || echo 000)
if [[ "$code" == "200" ]]; then
  echo "[deploy] relay OK (HTTP 200)"
else
  echo "[deploy] relay 健康检查未通过（HTTP $code），不阻塞——SSE 不可用时 console 回退轮询"
fi

# 5) 清理
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy] === $TAG 部署完成 ==="
