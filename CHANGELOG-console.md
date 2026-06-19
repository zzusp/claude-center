# Console + Relay 更新日志

> 跟随 `cc-vX.Y.Z` tag。两个服务（`apps/console` + `apps/relay`）整体发版，避免 SSE 事件契约分裂。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义版本（SemVer）。

新版本节由开发者**手工填写**：CI 在打 `cc-vX.Y.Z` tag 时校验 `## [X.Y.Z]` 节存在且非空，缺则 fail。
抽取脚本：`node scripts/extract-changelog.mjs CHANGELOG-console.md X.Y.Z --check`。

## [Unreleased]

### Added

- 部署流水线：`cc-v*` tag 触发 GitHub Actions，自动 build + SSH 部署到生产服务器，docker compose 起 console/relay。
- console 顶栏 brand 区显示当前版本号（CI build 时注入 `NEXT_PUBLIC_APP_VERSION`）。

### Changed

- `apps/console/next.config.mjs` 启用 `output: "standalone"`，减小 Docker 镜像体积。

### Fixed

- _（空）_

## [0.1.0] - 2026-06-19

### Added

- 初始 MVP：任务调度、Worker 心跳、Claude Code 执行、PR 创建。
- SSE 中转服务（可选），与数据库轮询双线择优。
- 完整说明见 `docs/spec/claude-center-mvp.md`。
