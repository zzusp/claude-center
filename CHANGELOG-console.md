# Console + Relay 更新日志

> 跟随 `cc-vX.Y.Z` tag。两个服务（`apps/console` + `apps/relay`）整体发版，避免 SSE 事件契约分裂。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义版本（SemVer）。

新版本节由开发者**手工填写**：CI 在打 `cc-vX.Y.Z` tag 时校验 `## [X.Y.Z]` 节存在且非空，缺则 fail。
抽取脚本：`node scripts/extract-changelog.mjs CHANGELOG-console.md X.Y.Z --check`。

## [Unreleased]

## [0.2.2] - 2026-06-19

### Internal

- CI 验证版本：跑一次完整 `deploy-web` 流水线，验证 (a) repo Workflow permissions 改为 write 后 release job 不再 403、(b) build job 新增的 `apps/console/.next/cache` 缓存步骤首次落盘可用。无运行时改动。

## [0.2.1] - 2026-06-19

### Fixed

- 登录 cookie 在 HTTP 部署下被浏览器丢弃导致登录后回不到中控台：`/api/auth/login` 设置 `cc_session` cookie 时 `secure` 标志改为跟随请求实际协议判定（反代时优先看 `x-forwarded-proto`，否则看请求 URL protocol），HTTPS 仍开 Secure、HTTP 直接暴露时放宽。

## [0.2.0] - 2026-06-19

### Added

- 部署流水线：`cc-v*` tag 触发 GitHub Actions，自动 build + SSH 部署到生产服务器，docker compose 起 console/relay。
- console 顶栏 brand 区显示当前版本号（CI build 时注入 `NEXT_PUBLIC_APP_VERSION`）。
- `apps/console/Dockerfile`（Next standalone 多阶段）+ `apps/relay/Dockerfile`（精简 alpine runtime）+ `docker-compose.yml`（host-gateway 走宿主机 pg）。
- `scripts/deploy-on-server.sh` / `server-bootstrap.sh` / `deploy-web-trigger.mjs` / `extract-changelog.mjs`：服务器部署与本地发版自检脚本。
- `CHANGELOG-console.md` / `CHANGELOG-worker.md`：发版硬约束（缺 `## [X.Y.Z]` 节 CI 校验红）。
- 完整方案 `docs/spec/deployment-pipeline.md`。

### Changed

- `apps/console/next.config.mjs` 启用 `output: "standalone"` + `outputFileTracingRoot`，适配 monorepo workspace。
- 部署架构：CI runner 在境外 checkout tag → `tar czf` → scp 到服务器 `/tmp/` → 解压 rsync 覆盖 `/opt/claude-center/`（保留 `.env`）。服务器**不再 git fetch**——国内服务器对 `github.com:443` 普遍不通。

### Fixed

- _（首版部署流水线，无 fix）_

## [0.1.0] - 2026-06-19

### Added

- 初始 MVP：任务调度、Worker 心跳、Claude Code 执行、PR 创建。
- SSE 中转服务（可选），与数据库轮询双线择优。
- 完整说明见 `docs/spec/claude-center-mvp.md`。
