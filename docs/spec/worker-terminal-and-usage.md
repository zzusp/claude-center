# worker 桌面端：运行终端配置 + 运行环境/用量展示

> 开工前快照。需求来自用户两轮消息：①套餐用量要显示「已用/总 + 剩余重置时间」；②展示 worker 所在机器的操作系统/终端；③桌面端可配置「运行终端」（列本机已装终端供选 + 手动输入）与「运行 claude 前的前置命令」（VPN/登录等，输入框自填）。

## 一、关键事实（实测，决定设计边界）

- **用量 API 只给百分比**：`GET https://api.anthropic.com/api/oauth/usage`（worker 已在用，`inspect.ts:fetchUsage`）每个窗口仅返回 `utilization`(0–100) + `resets_at`(ISO)。实测响应：
  ```json
  {"five_hour":{"utilization":30.0,"resets_at":"2026-06-14T20:39:59+08:00"},
   "seven_day":{"utilization":49.0,"resets_at":"2026-06-16T13:59:59+08:00"},
   "extra_usage":{"is_enabled":false,"monthly_limit":null,"used_credits":null,...}}
  ```
  **没有绝对 token 数/总额**（`extra_usage` 本机禁用，且那是额外信用额度非主窗口）。与 Claude Code 自带 `/usage` 一致——官方也只给百分比。
  → 结论：「已用/总」用百分比表达（已用 X% / 100%）；真正能补的是**剩余重置时间**（`resets_at` 已拉到，旧 UI 没渲染）。

- **套餐 gate 已天然成立**：`usage` 仅当凭据为 OAuth 套餐账号（`.credentials.json` 有 `accessToken`）才采集；非套餐（api/unknown）→ `usage={}` → UI `usageSection` 隐藏。无需额外按 subscriptionType 判断。

- **前置命令机制已存在但受限**：`config.claudePreCommand`（`executor.ts:runClaudeJson`）已支持「同一 PowerShell 会话先跑前置命令再调 claude」，但①只能 env 配、桌面 UI 改不了；②写死 PowerShell 语法。

## 二、设计

### 1. 运行终端（自定义路径 + 本机检测）

- **检测**：`inspect.detectTerminals()` 探测本机已装终端，返回 `{name,command(全路径),family}[]`。
  - Windows：Windows PowerShell / PowerShell7(pwsh) / cmd（`where` 解析全路径）、Git Bash（探已知安装路径）、WSL（`where wsl`）。
  - POSIX：`which` 探 bash/zsh/fish/sh。
  - 全容错，探不到不返回该项。
- **配置**：`worker.json` 持久化 `terminalCommand`（终端可执行文件全路径，空=默认）+ `claudePreCommand`。env 兜底 `CLAUDE_CENTER_TERMINAL` / `CLAUDE_CENTER_CLAUDE_PRE_COMMAND`。
- **执行**（`executor.spawnClaude`，统一替换旧 `runClaudeJson`/`runClaude` 的 PS 分支）：
  - **直接形态**（默认终端 + 无前置命令）：`spawn(claude, argv)` 无 shell 解析——最稳，保持旧行为不变。
  - **终端形态**（配了前置命令 或 自定义终端）：在所选终端的一个会话里顺序跑 `<前置命令> <sep> <claude 调用>`，使前置命令设置的环境被 claude 继承。
    - prompt / 各路径 / claude 路径经**环境变量**传入，按终端家族**安全引用**（`terminal.ts`）：powershell→`$env:X`、cmd→`%X%`、bash→`"$X"`；分隔符 PS/bash=`;` cmd=`&`；调用含空格命令 PS=`& $env:X`。
    - model / session-id(UUID) / permission-mode / output-format 是无 shell 元字符的安全字面量，内联（沿用旧代码论证）。
    - `shell:false` spawn 终端可执行文件（含空格全路径安全），避免再过 cmd.exe 重解析。
    - WSL：声明 `WSLENV` 转发上述变量；Windows 路径/claude 需 WSL-native，属 best-effort（文档标注）。
  - **家族识别**：按终端文件名 basename（`terminal.shellFamily`），未识别在 Windows 回退 powershell 风格、其余回退 bash。前置命令语法由用户按所选终端自负。

### 2. 运行环境 / 用量展示（桌面 UI，`main.ts`）

- **OS**：`inspect.inspectOs()` → `Windows 10.0.x (x64)`，并入顶部 meta 行。
- **当前终端**：快照带 `terminalCommand` + `claudePreCommand`，「运行终端」卡片回显。
- **用量条**：`usageBar` 增「重置剩余 + 重置时刻」脚注；头部「已用 X% / 100%」。倒计时随 3s 刷新重算。

### 3. 数据流 / 接口

- 快照 `WorkerStatusSnapshot` 增 `os`、`terminalCommand`、`claudePreCommand`。
- runner 增 `listTerminals()` / `setTerminalCommand()` / `setPreCommand()`（改内存 + 持久化 worker.json；**不入 DB**，终端/前置命令仅桌面本机关心）。
- IPC/preload 增 `listTerminals` / `setTerminal` / `setPreCommand`。
- UI「运行终端」卡片：下拉（检测项 + 手动输入）+ 路径输入 + 前置命令文本框 + 保存。

### 4. 不做（限定 scope）

- 不报 DB/Console（OS/终端/前置命令仅桌面展示，避免迁移）。
- 定向「shell」指令仍走 PowerShell（与 claude 执行解耦，非本次范畴）。
- 用量绝对值（数据源没有）；opus/sonnet 细分窗口（用户只要 5h/7d）。

## 三、验证

- `npm run typecheck` / `npm run build`（worker 三包）。
- headless tsx（对 dist）：`terminal.ts` 家族渲染断言 + `detectTerminals`/`inspectOs` 实跑 + config round-trip(terminalCommand/claudePreCommand 持久化合并) + `spawnClaude` 终端脚本构造断言（不真跑 claude，断言拼出的脚本/argv 正确）。
- 落 `docs/acceptance/worker-terminal-usage/`。
