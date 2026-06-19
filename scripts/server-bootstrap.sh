#!/usr/bin/env bash
# 服务器首次准备脚本。在新服务器上 root 身份执行一次，把仓库 clone 到 /opt/claude-center 并写入 .env 占位。
#
# 用法（在服务器上）：
#   sudo bash -c "REPO_URL=https://github.com/zzusp/claude-center.git bash <(curl -fsSL <raw-url-of-this-file>)"
# 或：
#   git clone https://github.com/zzusp/claude-center.git /opt/claude-center
#   sudo bash /opt/claude-center/scripts/server-bootstrap.sh
#
# 注意：bootstrap 不会自动写入 DATABASE_URL 等敏感信息，只写占位与说明，必须人工填入。
set -Eeuo pipefail

if [[ "${1:-}" == "--check" ]]; then
  echo "[bootstrap] --check 模式：仅打印计划，不执行任何动作"
  echo "  - 确保 /opt/claude-center 存在并指向本仓库"
  echo "  - 写入 /opt/claude-center/.env 模板（若不存在）"
  echo "  - 验证 docker / docker compose 在 PATH"
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "[bootstrap] 需要 root（sudo bash $0）"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/claude-center}"
REPO_URL="${REPO_URL:-https://github.com/zzusp/claude-center.git}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[bootstrap] 未检测到 docker，请先装 docker engine"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[bootstrap] 未检测到 docker compose v2，请先装"
  exit 1
fi

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "[bootstrap] clone $REPO_URL → $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch --tags origin

if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<'EOF'
# /opt/claude-center/.env —— docker compose 的 env_file。**禁止提交 git**。
# 至少需要：
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
  echo "[bootstrap] 已写入 $APP_DIR/.env 模板（chmod 600）。请手工补全 DATABASE_URL 等。"
else
  echo "[bootstrap] $APP_DIR/.env 已存在，跳过模板写入"
fi

echo "[bootstrap] 完成。下一步：编辑 $APP_DIR/.env 后即可由 CI 调用 deploy-on-server.sh，或手工跑："
echo "  cd $APP_DIR && APP_VERSION=0.1.0 bash scripts/deploy-on-server.sh"
