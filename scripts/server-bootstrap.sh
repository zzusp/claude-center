#!/usr/bin/env bash
# 服务器首次准备脚本。在新服务器上 root 身份执行一次：解压一份代码 + 写 .env 模板。
#
# 关键设计：服务器**不依赖** GitHub 出站连通（国内服务器对 github.com:443 普遍不通）。
# 首次代码用 SFTP/scp 从本地推上来一份 tarball；后续 CI 部署也是 tag 触发后 runner 推 tarball。
#
# 用法（在服务器上）：
#   # 1) 从本地（能上 GitHub）打一份 tar，scp 上服务器：
#   #    tar czf /tmp/cc-bootstrap.tar.gz \
#   #      --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git \
#   #      --exclude=apps/worker/release --exclude=.env -C <repo-root> .
#   #    scp /tmp/cc-bootstrap.tar.gz ubuntu@<host>:/tmp/
#   # 2) 在服务器上：
#   sudo BUNDLE=/tmp/cc-bootstrap.tar.gz bash server-bootstrap.sh
#
# bootstrap 完成后：
#   - /opt/claude-center 已有代码
#   - /opt/claude-center/.env 是模板，**必须人工补全 DATABASE_URL**
#   - docker / compose 已检测在 PATH
# 之后由 CI 跑 cc-vX.Y.Z tag 接管后续部署。
set -Eeuo pipefail

if [[ "${1:-}" == "--check" ]]; then
  echo "[bootstrap] --check 模式：仅打印计划，不执行任何动作"
  echo "  - 确保 /opt/claude-center 存在并解压 \$BUNDLE 进去"
  echo "  - 写入 /opt/claude-center/.env 模板（若不存在）"
  echo "  - 验证 docker / docker compose 在 PATH"
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "[bootstrap] 需要 root（sudo bash $0）"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/claude-center}"
BUNDLE="${BUNDLE:-/tmp/cc-bootstrap.tar.gz}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[bootstrap] 未检测到 docker，请先装 docker engine（推荐阿里云镜像源，国内服务器对 download.docker.com 多不通）"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[bootstrap] 未检测到 docker compose v2，请先装"
  exit 1
fi
if [[ ! -f "$BUNDLE" ]]; then
  echo "[bootstrap] 缺 release bundle：$BUNDLE"
  echo "[bootstrap] 在本地：tar czf /tmp/cc-bootstrap.tar.gz --exclude=node_modules --exclude=.git ... ."
  echo "[bootstrap] 然后 scp 到服务器 /tmp/，再 sudo BUNDLE=... bash $0"
  exit 1
fi

mkdir -p "$APP_DIR"
chown -R ubuntu:ubuntu "$APP_DIR" 2>/dev/null || true

# 解压 bundle 到临时区，rsync 到 APP_DIR（保留 .env 若已存在）。
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$BUNDLE" -C "$stage"
src="$stage"
if [[ ! -f "$src/docker-compose.yml" ]]; then
  wrap=$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [[ -n "$wrap" && -f "$wrap/docker-compose.yml" ]]; then
    src="$wrap"
  else
    echo "[bootstrap] bundle 解压后找不到 docker-compose.yml"
    exit 1
  fi
fi
rsync -a --delete --exclude='.env' "$src/" "$APP_DIR/"
echo "[bootstrap] 代码已落在 $APP_DIR"

if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<'EOF'
# /opt/claude-center/.env —— docker compose 的 env_file。**禁止提交 git**。
# 必填：连接宿主机 postgres。host.docker.internal:host-gateway 由 docker-compose.yml 注入。
DATABASE_URL=postgresql://USER:PASSWORD@host.docker.internal:55432/claude_center

# 可选：定时任务 / 合并检查 / SSE 中转。参考根目录 .env.example。
# CLAUDE_CENTER_SCHEDULER_INTERVAL_MS=30000
# CLAUDE_CENTER_MERGE_CHECK_INTERVAL_MS=30000
# CLAUDE_CENTER_RELAY_URL=http://relay:8787
# CLAUDE_CENTER_RELAY_SECRET=
# CLAUDE_CENTER_RELAY_PUBLISH_TOKEN=
# CLAUDE_CENTER_RELAY_WORKER_TOKEN=
EOF
  chmod 600 "$APP_DIR/.env"
  chown root:root "$APP_DIR/.env"
  echo "[bootstrap] 已写入 $APP_DIR/.env 模板（chmod 600）。**手工补全 DATABASE_URL** 后才能部署。"
else
  echo "[bootstrap] $APP_DIR/.env 已存在，跳过模板写入"
fi

echo "[bootstrap] 完成。下一步：本地推 cc-vX.Y.Z tag 触发 CI 部署（CI 会 scp bundle 上来）。"
