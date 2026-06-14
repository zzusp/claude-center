# Round 1 — 全绿

环境：Windows 11 / worktree `worker-terminal-usage` / 已 `setup-worktree`（装依赖 + .env）。

## TC01 typecheck（三包）

`npm run typecheck` → db / console / worker 三包 `tsc --noEmit` 无输出（全过）。

## TC02 build

`npm -w @claude-center/worker run build` → 产物含 `apps/worker/dist/terminal.js`（3732B）等 8 个 js。

## TC03–TC12, TC15 headless 断言

`npx tsx docs/acceptance/worker-terminal-usage/scripts/verify-terminal-usage.mts` → **34 PASS / 0 FAIL**。要点：

- 家族拼接：PS `& $env:CLAUDE_CENTER_CLAUDE_CMD -p $env:CLAUDE_CENTER_PROMPT ... --settings $env:CLAUDE_CENTER_SETTINGS_PATH --output-format json`；bash `"$CLAUDE_CENTER_CLAUDE_CMD" -p "$CLAUDE_CENTER_PROMPT"`；cmd `%CLAUDE_CENTER_PROMPT%` + ` & ` 分隔。`full=false` 仅 `-p`。
- launch：ps `-Command`、cmd `/c`、bash `-lc`、wsl `bash -lc`。
- `inspectOs()` → `{"platform":"win32","release":"10.0.26200","label":"Windows 10.0.26200 (x64)"}`。
- `detectTerminals()` → Windows PowerShell / PowerShell 7 / cmd / **Git Bash(`D:\Program Files\Git\bin\bash.exe`，从 git 位置反推)** / WSL，均带全路径 + family。
- config：未持久化取 env；持久化 `terminalCommand`/`claudePreCommand` 覆盖 env，且保留先前 `maxParallel`。

## TC13–TC14 真 spawn env 还原

恶劣 prompt `line1 with "quotes" & spaces; %PATH% $weird\nline2 end` 经 `terminalLaunch` + `shell:false` spawn：
- powershell `Write-Output $env:CLAUDE_CENTER_PROMPT` → **round-trip OK**
- git-bash `printf "%s" "$CLAUDE_CENTER_PROMPT"` → **round-trip OK**

证实「prompt 经 env 传入 + 按家族引用」对含空格/引号/换行/shell 元字符的值不被破坏（真进程、本机）。

## 结论

15/15 case PASS。Electron GUI 与真 claude 任务不在本轮（后台会话无法驱动 GUI）；执行链以脚本构造正确 + 真 spawn env 还原 + 默认终端直接 argv 旧路径不变共同佐证。
