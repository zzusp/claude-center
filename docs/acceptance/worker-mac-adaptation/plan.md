# 桌面 Worker macOS 适配 — 真机验证与修复

## 需求

桌面端（Electron Worker，`apps/worker`）适配 Mac，并在当前这台 Mac（Intel x86_64，macOS 13.7.8 / Darwin 22.6.0，zsh 登录 shell）上完成真机验证。

PR #122（`d5e7406 桌面端适配mac电脑`）此前已做过一轮**代码层** Mac 适配（`mac-path.ts`、`main.ts` 的 darwin 窗口生命周期、`shell.ts`/`terminal.ts`/`inspect.ts` 的非 win32 分支），但**未在真 Mac 上跑过**——属于「build 绿 ≠ 运行绿」。本轮目标是真机跑起来、抓只在 macOS 运行时暴露的缺陷并修复。

## 方案

1. 在本机装依赖（electron 二进制走 npmmirror 镜像，直连 github releases 被网络挡）、构建、起 headless worker、起真 Electron GUI，逐层验证 macOS 运行时路径。
2. 并行用多 agent 工作流对 worker 源码做 **macOS 运行时正确性审计**（编译能过、运行时炸的 bug），对抗性验证后得 8 个确认项。
3. 修复审计 + 真机观察暴露的缺陷，逐项在本机回归。

## 改动（按缺陷）

| 级别 | 缺陷 | 文件:位置 | 修复 |
|---|---|---|---|
| **B1 blocker** | 窗口被 `await worker.start()` 卡住：DB 不可达 → 只有 Dock 图标、无窗口（与安装手册 §11「窗口显示 DB 健康度」矛盾） | `apps/worker/src/main.ts` whenReady | **窗口先建**：先注册 IPC + `createWindow()`，再非阻塞 `worker.start().catch(log)`；加 `unhandledRejection` 兜底 |
| B1 配套 | DB 死主机时 pg 走 OS TCP 默认（~75s）才失败，拖死状态查询 | `packages/db/src/client.ts` getPool | 加 `connectionTimeoutMillis: 8000` |
| B1 配套 | 窗口先于 start() 渲染后，能力区靠 15s 轮询最长空窗 15s | `apps/worker/src/window-html.ts` bootstrap | 冷启动额外快轮询（1.2/2.5/5/9s）再回落 15s |
| **M1 major** | 任务取消/超时在 macOS 泄漏 Claude **子进程树**：非 detached 子进程继承 worker 进程组，`process.kill(-pid)` ESRCH → 回退 `child.kill` 只杀直接子进程，孙进程（git/gh/npm/MCP/子代理）泄漏；终端形态更是完全 no-op | `apps/worker/src/shell.ts` runCommand + `executor.ts` spawnClaude | 新增 `newProcessGroup` 选项（detached:true 但**保留管道 stdio、不 unref**），POSIX 任务/终端形态都置真，使子进程成进程组组长→整组可杀；超时路径改用 `killProcessTree` |
| **M2 major** | fish 登录 shell 下 `"$PATH"` 字符串化为**空格**分隔，`mergePath` 按 `:` 切分 → PATH 损坏，claude/git 解析不到（fish 用户 Finder 启动静默失效） | `apps/worker/src/mac-path.ts` | PATH 提取改用 `/usr/bin/printenv PATH`（读真实环境变量，任何 shell 都冒号分隔，含空格目录也安全） |
| m1 minor | `getProcessStartTime` 用 `ps -o lstart=` + `Date.parse`，fr/ru locale 下日期本地化 → NaN → `isSameProcessAlive` 误判进程已退 | `apps/worker/src/shell.ts` | ps spawn 强制 `LC_ALL=C LC_TIME=C` |
| m2 minor | 启动 8s `spawnSync` 阻塞主线程 | `apps/worker/src/mac-path.ts` | 超时 8s→5s |
| 显示 | 「系统」显示 `macOS 22.6.0`（Darwin 内核版本，os.release()）而非产品版本 | `apps/worker/src/inspect.ts` inspectOs | darwin 用 `sw_vers -productVersion`（13.7.8），取不到回退内核版本 |

> m3（mac 包无 app 图标，用默认火箭图标）为纯外观、需 .icns 资产，**本轮延后**，已记 report。

## 验证

逐项真机回归，详见 `matrix.csv` + `round-1.md`。可复跑脚本：`scripts/verify-killtree-posix.mjs`（M1 进程树 kill，带对照组复现旧 bug）。
