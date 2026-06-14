# worker 运行终端配置 + 运行环境/用量展示 — 验收报告（全绿）

Round 1 一轮全绿，15/15 case PASS（明细见 `matrix.csv` / `round-1.md`）。

## 交付

1. **套餐用量**：5 小时 / 7 天窗口由「已用 X%」升级为「已用 X% / 100% + 重置倒计时（剩余 + 重置时刻）」。受数据源限制（`/api/oauth/usage` 实测只给 `utilization` 百分比、无绝对 token 数），「已用/总」以百分比表达。套餐 gate 沿用「有 usage 数据才显示」。
2. **运行环境展示**：桌面窗口顶部显示操作系统（`Windows 10.0.26200 (x64)`），「运行终端」卡片回显当前终端 + 前置命令。
3. **运行终端可配**：下拉列本机检测到的终端（含 Git Bash 从 git 位置反推）+ 手动输入路径；持久化 `worker.json`，env `CLAUDE_CENTER_TERMINAL` 兜底。
4. **前置命令可配**：文本框自填，按所选终端语法；持久化 `worker.json`，env `CLAUDE_CENTER_CLAUDE_PRE_COMMAND` 兜底。前置命令与 claude 同会话顺序执行，env 被继承。

## 证据要点

- typecheck（三包）/ build 绿；headless 34 PASS / 0 FAIL；真 spawn 恶劣 prompt round-trip 还原（PS + git-bash）；UI 脚本语法可解析。
- 默认终端 + 无前置命令仍走直接 argv spawn，旧行为不变（零回归面）。

## 残留 / 后续

- Electron GUI 实测与真 claude 任务跑通未在本轮（后台会话无法驱动 GUI），建议有人值守时桌面端点一次「运行终端」配置 + 跑一个真任务复核。
- WSL 为 best-effort（已 `WSLENV` 转发变量，但需 WSL-native claude/路径）。
- OS/终端/前置命令仅桌面展示，未入 DB/Console（可按需后续扩展）。
