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

## [0.2.0] - 2026-06-19

### Added

- 桌面端首次走 CI 标准化打包，产物上传到 GitHub Release Assets：
  - Windows：`ClaudeCenter-Worker-0.2.0-win-x64.exe`（NSIS 安装包） + `-win-x64-portable.exe`（免安装）
  - macOS：`ClaudeCenter-Worker-0.2.0-mac-x64.dmg` + `-mac-arm64.dmg`
- `apps/worker/package.json` 加 electron-builder 配置（`build` 字段）+ `dist:win` / `dist:mac` / `dist:check` scripts。
- `.github/workflows/release-worker.yml`：`worker-v*` tag 触发 matrix（windows-latest + macos-latest）并行打包，CHANGELOG-worker.md 缺节 → CI 校验红。
- `apps/worker/scripts/dist-check.mjs`：零副作用配置自检。

### Changed

- worker package.json 的 `version` 字段由 CI runner 在 build 前 patch 成 tag 版本号（避免源码与发版版本漂移）。

### Fixed

- release-worker.yml 调整步骤顺序：`npm ci` 必须在 `Patch worker version` 之前（npm ci 严格比对 lock 与 workspace package.json 版本）。

## [0.1.0] - 2026-06-19

### Added

- 初始 MVP：心跳、任务领取、Claude Code 执行、本地项目路径关联。
- 桌面端 UI：工作态切换、并行容量调整、终端选择、套餐用量展示。
