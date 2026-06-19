# Worker（桌面端）更新日志

> 跟随 `worker-vX.Y.Z` tag。每个 tag 触发 GitHub Actions 在 `windows-latest` + `macos-latest` 并行打包。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义版本（SemVer）。

新版本节由开发者**手工填写**：CI 在打 `worker-vX.Y.Z` tag 时校验 `## [X.Y.Z]` 节存在且非空，缺则 fail。
抽取脚本：`node scripts/extract-changelog.mjs CHANGELOG-worker.md X.Y.Z --check`。

产物（GitHub Release Assets）：

- Windows：`ClaudeCenter-Worker-X.Y.Z-win-x64.exe`（NSIS 安装包）、`ClaudeCenter-Worker-X.Y.Z-win-x64-portable.exe`（免安装）
- macOS：`ClaudeCenter-Worker-X.Y.Z-mac-x64.dmg`、`ClaudeCenter-Worker-X.Y.Z-mac-arm64.dmg`

> 当前**不做代码签名**：Windows 首启动可能弹 SmartScreen，macOS 首启动可能弹 Gatekeeper。后续接入证书后会自动签名 + macOS notarize，无需用户手动绕过。

## [Unreleased]

### Added

- electron-builder 标准化打包配置：win nsis + portable、mac dmg（x64 + arm64）。
- CI matrix 跨平台并行打包，artifact 上传到 GitHub Release。

### Changed

- _（空）_

### Fixed

- _（空）_

## [0.1.0] - 2026-06-19

### Added

- 初始 MVP：心跳、任务领取、Claude Code 执行、本地项目路径关联。
- 桌面端 UI：工作态切换、并行容量调整、终端选择、套餐用量展示。
