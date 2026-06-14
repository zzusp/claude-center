# worker 运行终端配置 + 运行环境/用量展示 — 验收方案

## 需求

1. 套餐（pro/max）账号：套餐用量卡片显示 5 小时 / 7 天窗口「已用/总 + 剩余重置时间」。
2. 展示 worker 所在机器的操作系统 / 运行终端。
3. 桌面端可配置「运行终端」：列本机已装终端供选 + 手动输入路径。
4. 桌面端可配置「运行 claude 前的前置命令」（VPN / 代理 / 登录），输入框自填。

## 方案（详见 `docs/spec/worker-terminal-and-usage.md`）

- 用量 API（`/api/oauth/usage`，实测）只返回 `utilization`(%) + `resets_at`，无绝对 token 数 → 「已用/总」以百分比表达，补**重置倒计时**（数据早已拉到，旧 UI 未渲染）。套餐 gate 沿用「有 usage 数据才显示」。
- `terminal.ts`（新）：按 shell 家族（powershell/cmd/bash）收敛 env 引用 / 分隔符 / launch 参数；`buildClaudeScript` 纯函数拼脚本，便于断言。
- `inspect.ts`：`inspectOs()` + `detectTerminals()`（Windows 探 PowerShell/pwsh/cmd/Git Bash[含从 git 位置反推]/WSL；POSIX 探 bash/zsh/fish/sh）。
- `config.ts`：`worker.json` 持久化 `terminalCommand` / `claudePreCommand`，env 兜底，持久化优先。
- `executor.ts`：`spawnClaude` 统一——默认终端+无前置命令走直接 argv spawn（旧行为不变）；否则在所选终端一个会话跑 `<前置命令> <sep> <claude 调用>`，prompt/路径经 env 安全引用，`shell:false` spawn。
- `runner.ts` / preload / `main.ts`：快照增 `os`/`terminalCommand`/`claudePreCommand`；IPC `listTerminals`/`setTerminal`/`setPreCommand`；UI「运行终端」卡片 + OS meta + 用量重置倒计时。

## 改动文件

- 新增：`apps/worker/src/terminal.ts`
- 改：`apps/worker/src/{inspect,config,executor,runner,main}.ts`、`apps/worker/preload.cjs`、`README.md`

## 验证手段

- `npm run typecheck`（三包）/ `npm -w @claude-center/worker run build`。
- headless：`scripts/verify-terminal-usage.mts`（对 dist 断言家族拼接 + OS/终端检测 + config round-trip）。
- 真 spawn：恶劣 prompt（引号/空格/换行/元字符）经 powershell `$env:` 与 git-bash `"$VAR"` round-trip 还原。
- UI 内联脚本 `new Function` 语法校验。
- 限制：Electron GUI 与真 claude 任务不在本轮（后台会话无法驱动 GUI）；执行链以「脚本构造正确 + 真 spawn env 还原 + 直接 argv 旧路径不变」佐证。
