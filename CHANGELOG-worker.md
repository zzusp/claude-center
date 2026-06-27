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

### Changed

- 任务下发 prompt 强化 e2e 验证硬线：`apps/worker/src/executor.ts:e2eGuidanceSection` 在原有「e2e 工具栈白名单 + 三要素跳过规约」之上新增「写"未跑/无法验证"前必走三步硬线」段——明确给出 Worker↔Console 契约是 DB（DB 唯一权威 + 双向轮询），列出常见错觉的等价 import 路径（`addConversationMessage` → `claimNextConversationTurn` → `upsertConversationSession` → `finalizeConversationTurn`），并附「❌ 借口 vs ✅ 等价路径」反例表。背景：「实时对话页重设计」任务首轮把端到端 Worker 应答标「未跑」直接收口，实际仓库内有完整可代码模拟的 DB 契约路径——加固后任何 worker 任何机器下发的任务都强制注入这段。

## [0.2.2] - 2026-06-22

### Added

- 实时对话支持添加附件：会话消息可携带附件，executor 将附件一并传给 Claude Code 执行。
- 记录任务开发消耗的 token 量：executor 采集每次任务的 token 用量，任务列表可查看与排序。
- 桌面端支持在应用界面内配置数据库连接信息（原先仅支持环境变量）。

### Changed

- 任务完成提交 PR 流程优化：引入 PR body 测试计划合并门控（test-plan gate），用例全绿才自动合并。

### Fixed

- 修复测试计划解析误判导致「PR 中 case 全部 pass 却未自动合并」的问题。
- 采集命令日志时对失败信息中的敏感信息脱敏。
- 桌面端套餐用量（Usage）采集失败时不再重试。
- 修复任务在某些情况下「停不下来」的问题（取消卡住的任务）。

## [0.2.1] - 2026-06-20

### Added

- 桌面端支持配置 SSE 中转服务地址（`CLAUDE_CENTER_RELAY_URL`），可用时走亚秒级实时线、不可用时退回数据库轮询。
- 任务支持设置动态工作流：executor 按任务配置组织执行流程。

### Fixed

- macOS 真机适配：修复进程树识别（inspect/shell）、登录 shell PATH 解析（`mac-path`）、版本号显示与窗口行为。
- macOS 默认窗口尺寸自适应工作区，避免超出屏幕或贴边。
- 任务第二轮成功后 PR 未保存到任务的问题。

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
