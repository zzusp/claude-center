# 部署流水线（CI/CD）

> 状态：实施中。两条 tag 路径分别覆盖「Web 端」（console + relay）与「桌面端」（worker）。CHANGELOG 是发版硬约束（缺节 CI 直接红）。

## 目标与约束

- **两条 tag 路径互不相干**
  - `cc-vX.Y.Z` → Web 端：CI 在 GitHub Runner 跑 typecheck/build/CHANGELOG 校验 → 通过后 SSH 上服务器 → `git fetch tag + docker compose build + up` → `gh release create`
  - `worker-vX.Y.Z` → 桌面端：CI matrix `windows-latest` + `macos-latest` 并行跑 electron-builder → 上传安装包到 GitHub Release
- **CHANGELOG 是 ship 硬线**：tag 推送前必须在 `CHANGELOG-console.md` / `CHANGELOG-worker.md` 写好对应版本节，否则 CI 校验红、Release 不发
- **镜像不进 registry**：CI 不推 GHCR / Docker Hub，服务器 `docker compose build` 本地构建（用户选择，减少凭据面）。代价：每次部署占服务器 CPU 几分钟。
- **服务器假设**：宿主机 Ubuntu，已自建 PostgreSQL 监听 `:55432`、已装 docker / docker compose、root 可登。详见 `docs/ops/.env`。
- **console 显示当前版本**：build 时把 `cc-vX.Y.Z` 注入 `NEXT_PUBLIC_APP_VERSION`，顶栏侧边 brand 下方一行小字展示。
- **worker 安装包平台**：Windows（NSIS 安装包 + portable，x64）+ macOS（dmg，x64 + arm64）。不打 Linux 包（用户未要）。代码签名暂不做（需证书后再加）。
- **配置文件**：服务器 `/opt/claude-center/.env` 是 compose 的 env_file，**不进 git**。本地 `docs/ops/.env` 与之内容同步，仅供 ops 人员查阅与首次 bootstrap。

## 仓库布局

```
.github/workflows/
├── deploy-web.yml          # cc-v* tag 触发
└── release-worker.yml      # worker-v* tag 触发

apps/
├── console/Dockerfile      # 多阶段 build → next standalone
└── relay/Dockerfile        # 多阶段 build → node dist/main.js

docker-compose.yml          # console + relay 两个服务，extra_hosts 通宿主机 pg

CHANGELOG-console.md        # Keep a Changelog 风格
CHANGELOG-worker.md

scripts/
├── server-bootstrap.sh     # 首次在服务器上跑：创建 /opt/claude-center、写 .env、克隆仓库
├── deploy-web-trigger.mjs  # 本地辅助：检查 CHANGELOG/clean tree，push cc-vX.Y.Z tag
└── extract-changelog.mjs   # 公共：从 CHANGELOG 抽 [vX.Y.Z] 节，被 CI 与本地脚本复用

docs/spec/deployment-pipeline.md  # 本文档
docs/ops/.env                     # 服务器登录 + DATABASE_URL（gitignore）
```

## tag 命名与版本号

- **`cc-vX.Y.Z`**（语义版本，`X`/`Y`/`Z` 为非负整数）
  - Web 端整体版本，包含 `console` + `relay`。同步发版，避免 SSE 契约分裂。
  - 触发 `deploy-web.yml`。
- **`worker-vX.Y.Z`**
  - 桌面端版本，独立于 Web 端。worker 与 console 通过 DB schema + relay event 契约耦合，schema 不变就允许跨版本互通。
  - 触发 `release-worker.yml`。

正则严格（避免 `cc-v1.2.3-beta` 之类绕过校验）：

```yaml
on:
  push:
    tags:
      - 'cc-v[0-9]+.[0-9]+.[0-9]+'        # deploy-web
      - 'worker-v[0-9]+.[0-9]+.[0-9]+'    # release-worker
```

预发版（rc/beta）暂不支持，需要再加规则。

## Web 端部署（`cc-v*` → `deploy-web.yml`）

### Job 编排

```
build (ubuntu-latest)
  ├─ checkout @ tag
  ├─ Node 22 + npm ci
  ├─ npm run typecheck
  ├─ npm run build           # 早 fail：本地能编译过，服务器一般也能
  ├─ 解析 tag → APP_VERSION（去 cc-v 前缀）
  ├─ scripts/extract-changelog.mjs CHANGELOG-console.md vX.Y.Z
  │     → 不存在 → exit 1；存在 → 写到 $GITHUB_OUTPUT.notes
  └─ outputs: app_version, release_notes

deploy (needs: build, ubuntu-latest)
  ├─ 准备 SSH（webfactory/ssh-agent 加 secrets.DEPLOY_SSH_KEY）
  ├─ 把 known_hosts 写入（避免首次连接交互；用 secrets.DEPLOY_KNOWN_HOSTS）
  ├─ ssh root@HOST 'bash -s' < scripts/deploy-on-server.sh APP_VERSION
  │     脚本里：
  │       cd /opt/claude-center
  │       git fetch --tags origin
  │       git checkout cc-vX.Y.Z
  │       export APP_VERSION=X.Y.Z
  │       docker compose build console relay
  │       docker compose up -d console relay
  │       docker image prune -f       # 留最近 3 个
  └─ 健康检查：
        curl -fsS http://HOST:3000/api/auth/me  → 401（未登录正常态）
        curl -fsS http://HOST:8787/healthz       → 200（如果对外）
        失败 → 任务红、保留旧版本（docker compose up -d 不会停旧服务，回滚靠下一行）

release (needs: deploy)
  └─ gh release create cc-vX.Y.Z --notes "$RELEASE_NOTES" --target $GITHUB_SHA
```

### Secrets 一览（Web 端）

| Secret | 用途 |
|---|---|
| `DEPLOY_SSH_KEY` | SSH 私钥（**用 key 不用密码**，密码 CI 上不合规）。首次需手工把对应公钥放到服务器 `~ubuntu/.ssh/authorized_keys` 与 `~root/.ssh/authorized_keys` |
| `DEPLOY_HOST` | `115.159.161.47` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_USER` | `ubuntu`（脚本里 `sudo -i` 切 root） |
| `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -p 22 115.159.161.47` 的输出，避免 CI 首连接询问 |

> SSH 密码 (`PASSWORD=dTkTnaGsN9KUsYB`) 仍保留在 `docs/ops/.env` 仅供应急手动登录，CI 不用。

### 服务器目录结构（部署后）

```
/opt/claude-center/                   # git checkout
├── .env                              # ★ 不进 git，首次 bootstrap 时手工放
├── docker-compose.yml
├── apps/{console,relay}/Dockerfile
└── ...

/var/lib/claude-center/               # 数据卷预留位（postgres 是宿主机自建不走 compose volume，此目录暂空）
```

### Console 版本展示

build 时通过 Dockerfile build args 注入：

```dockerfile
ARG APP_VERSION
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV APP_VERSION_BUILT_AT=$BUILD_TIMESTAMP
```

`apps/console/app/ui/shell.tsx` 侧栏 brand 区下方加一行小字：

```tsx
<span className="brand-text">ClaudeCenter</span>
<span className="brand-version">v{process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}</span>
```

未注入时（本地 dev 或忘传 build arg）显示 `vdev`，**不报错**。CHANGELOG 版本 + console 顶栏显示 + git tag 三处一致是发版的人工 checklist。

## 桌面端打包（`worker-v*` → `release-worker.yml`）

### Job 编排

```
build (matrix: [windows-latest, macos-latest])
  ├─ checkout @ tag
  ├─ Node 22 + npm ci
  ├─ 校验 CHANGELOG-worker.md 有 vX.Y.Z 节（首个 matrix job 跑就够，用 always 标）
  ├─ npm -w @claude-center/db run build
  ├─ npm -w @claude-center/relay-client run build
  ├─ windows 分支：npm -w @claude-center/worker run dist:win
  ├─ macos 分支：  npm -w @claude-center/worker run dist:mac
  └─ upload-artifact: apps/worker/release/*.{exe,dmg,blockmap,yml}

release (needs: build, ubuntu-latest)
  ├─ download-artifact (两个 matrix 都下载到一个目录)
  ├─ scripts/extract-changelog.mjs CHANGELOG-worker.md vX.Y.Z → release notes
  └─ gh release create worker-vX.Y.Z --notes "$NOTES" 把 artifact 全传上
```

### electron-builder 配置（`apps/worker/package.json`）

monorepo + npm workspaces 下 electron-builder 的关键约束：

1. **源代码与原生依赖来自 workspace 根**：`@claude-center/db` 和 `@claude-center/relay-client` 都是 workspace package；它们的 `dist/` 已 prebuild，electron-builder 只需把它们当普通 npm 依赖处理。pg 没有 native module 部分（pg 是纯 JS），不需要 `npmRebuild`。
2. **electron-builder 入口**：`main: dist/main.js`（已是）
3. **`files`**：默认包含整个 package。需要显式列以避免 `prompts`/`config`/`scripts` 漏带。
4. **`asar: true`**：默认开。`prompts/*` 与 `preload.cjs` 也得进 asar。
5. **`directories.output`**：`release/`（gitignore）。
6. **不签名**：`win.signAndEditExecutable: false`、`mac.identity: null`。后续要 macOS 代码签名再加 `CSC_LINK` / `APPLE_ID` 等 secrets。
7. **windows target**：`nsis`（installer）+ `portable`（免装版）。
8. **mac target**：`dmg`，arch `x64` 与 `arm64` 各打一份。
9. **`publish: null`**：不让 electron-builder 自己上传 Release（我们用 `gh release create` 统一控）。

### Secrets 一览（桌面端）

| Secret | 用途 |
|---|---|
| `GITHUB_TOKEN` | 内置，`gh release create` 用 |

不需要别的——不做代码签名、不推 registry。

### macOS notarization / Windows 签名

**当前不做**。后果：

- Windows：用户首次跑会看到 SmartScreen「不常见的应用」。点 `更多信息 → 仍要运行` 即可。
- macOS：用户首次打开会看到 Gatekeeper「无法打开」。需 `xattr -d com.apple.quarantine /Applications/ClaudeCenter\ Worker.app` 或右键打开。

升级路径：申请代码签名证书后，加 `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` secrets，electron-builder 会自动签名 + notarize。

## CHANGELOG 维护

两个独立 CHANGELOG：

- `CHANGELOG-console.md`：cc-v* tag 对应
- `CHANGELOG-worker.md`：worker-v* tag 对应

格式遵循 [Keep a Changelog](https://keepachangelog.com/)：

```markdown
## [Unreleased]

## [0.2.0] - 2026-06-20
### Added
- ...
### Changed
- ...
### Fixed
- ...
```

### 抽取脚本约束（`scripts/extract-changelog.mjs`）

签名：`node scripts/extract-changelog.mjs <file> <version>`

输出：stdout 打印该版本节正文（不含 `## [vX.Y.Z]` 标题行）；找不到该节 exit 1。

被两处复用：

1. CI workflow：抽取 release notes 写到 `$GITHUB_OUTPUT`
2. 本地 `scripts/deploy-web-trigger.mjs`：push tag 前自检

`--check` 模式：仅校验 file 存在且包含 `## [vX.Y.Z]` 行，不输出正文（CI fail fast）。

## 健康检查与回滚

### 健康检查

`deploy-web.yml` 部署后：

```bash
curl -fsS -m 5 "http://${DEPLOY_HOST}:3000/api/auth/me" -o /dev/null -w "%{http_code}\n"
# 期待 401（未登录正常态）
```

`401` / `200` 都算通过；`500` / 超时 / 拒连 fail，CI 红、不发 Release。

### 回滚

> 不自动化（避免幻觉回滚到坏版本）。手工流程：

```bash
ssh ubuntu@115.159.161.47
sudo -i
cd /opt/claude-center
git tag -l 'cc-v*' --sort=-v:refname | head -5    # 看可回滚版本
git checkout cc-vX.Y.OLD
docker compose build console relay
docker compose up -d console relay
```

旧 git tag 一直在，回滚就是 checkout 旧 tag 重建镜像。

## 安全与凭据红线

1. **`docs/ops/.env` 在 gitignore**（已是 `.env.*` 规则覆盖；本仓 `docs/ops/.env` 因目录前缀显式 gitignore 失效，要手工确认）。
2. **服务器 `/opt/claude-center/.env`** 是 compose env_file，文件权限 `600` 仅 root 可读。
3. **CI secrets** 严禁打印 / 写入产物 / 进 Docker 镜像。
4. **DATABASE_URL** 不进镜像：通过 compose env_file 注入容器。
5. **postgres 端口** `55432` 当前公网可访问（用户提供的连接串就是公网 IP）。建议 ops 收口为防火墙只允许 docker 容器网段访问，CI 范围内不动。

## 不在本期范围

- 蓝绿 / 滚动部署：服务器单机直接重启即可。
- 自动回滚：高风险，手工流程更稳。
- 多环境（staging / prod）：单环境 prod，需要 staging 时再加 `cc-staging-v*` tag 路径。
- 代码签名 / notarization：见上文升级路径。
- 镜像 registry：用户明确不要。
- 自动注水 CHANGELOG：手工维护质量更高（用户选择）。
