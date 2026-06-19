#!/usr/bin/env bash
# 在服务器上执行的部署脚本。被 .github/workflows/deploy-web.yml 通过 SSH 调起，传入 APP_VERSION（无 cc-v 前缀）。
# 也可手动运行：sudo bash deploy-on-server.sh 0.2.0
#
# 假设：
#   - /opt/claude-center 已 clone 该仓库且 git remote 通；
#   - /opt/claude-center/.env 存在（含 DATABASE_URL 等），权限 600；
#   - 宿主机已装 docker + docker compose v2；
#   - postgres 跑在宿主机 127.0.0.1:55432（compose 内服务通过 host.docker.internal 或公网 IP 访问）。
set -Eeuo pipefail

APP_VERSION="${1:-${APP_VERSION:-}}"
if [[ -z "$APP_VERSION" ]]; then
  echo "[deploy-on-server] 用法：bash deploy-on-server.sh <APP_VERSION>"
  exit 2
fi

# 简单版本号校验（与 cc-v tag 正则保持一致）。
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[deploy-on-server] APP_VERSION 格式错误（应为 X.Y.Z）：$APP_VERSION"
  exit 2
fi

APP_DIR="${APP_DIR:-/opt/claude-center}"
TAG="cc-v${APP_VERSION}"

cd "$APP_DIR"
echo "[deploy-on-server] === $TAG → $APP_DIR ==="

# 必要文件：.env 与 docker-compose.yml。前者必须由 ops 预先放置。
if [[ ! -f .env ]]; then
  echo "[deploy-on-server] 缺 $APP_DIR/.env（含 DATABASE_URL 等）。先 bootstrap 再部署。"
  exit 1
fi
chmod 600 .env || true

# 拉最新 tag。--force 是为了应对 tag 被重新打的边角（不应该，但出现时不阻塞部署）。
git fetch --tags --force origin
git checkout --force "$TAG"

# 显式给 compose 传 APP_VERSION：用于镜像 tag 与 build args（Dockerfile 把它编进 NEXT_PUBLIC_APP_VERSION）。
export APP_VERSION

echo "[deploy-on-server] docker compose build console relay (APP_VERSION=$APP_VERSION)"
docker compose build console relay

echo "[deploy-on-server] docker compose up -d console relay"
docker compose up -d console relay

# 健康检查（容器内 HEALTHCHECK 也跑，但 CI 侧需要一个明确信号）。
echo "[deploy-on-server] 等待 console 就绪（最多 60s）"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:3000/api/auth/me || echo 000)
  if [[ "$code" == "200" || "$code" == "401" ]]; then
    echo "[deploy-on-server] console OK (HTTP $code)"
    break
  fi
  if [[ $i -eq 12 ]]; then
    echo "[deploy-on-server] console 未就绪（最后 HTTP $code）"
    docker compose logs --tail=80 console
    exit 1
  fi
  sleep 5
done

# relay 健康（如果开启）。不强制：用户可能没配 RELAY 环境，relay 容器会启失败但 console 仍可用。
code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:8787/healthz || echo 000)
if [[ "$code" == "200" ]]; then
  echo "[deploy-on-server] relay OK (HTTP 200)"
else
  echo "[deploy-on-server] relay 健康检查未通过（HTTP $code），不阻塞——SSE 不可用时 console 会回退轮询"
fi

# 清理悬挂镜像（保留最近 3 个版本）。
docker image prune -f >/dev/null 2>&1 || true

echo "[deploy-on-server] === $TAG 部署完成 ==="
