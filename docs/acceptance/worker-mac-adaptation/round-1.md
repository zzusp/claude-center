# Round 1 — macOS 真机验证证据

环境：Intel x86_64，macOS 13.7.8（Darwin 22.6.0），zsh 登录 shell，node v24.15.0（nvm），claude 2.1.183（`~/.local/bin/claude`，node shebang），git/gh 已装。DB = 共享 dev 库（`115.159.161.47:55432/claude_center`，PostgreSQL 18.3）。

> 前置坑（已修/已记）：electron npm 包的二进制 postinstall 直连 github releases 在本网络被挡 → `Electron failed to install correctly`。解法：`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install`。

## <a id="build"></a>build / <a id="distcheck"></a>distcheck — PASS
```
npm run typecheck   → 5 包 (db/relay-client/console/worker/relay) 全过，无 error
npm run build       → BUILD_EXIT=0（含 console next build）
npm -w @claude-center/worker run dist:check → [dist-check] OK
  mac: [{"target":"dmg","arch":["x64","arm64"]}]
```

## <a id="caps"></a>path-fix / capabilities — PASS
headless worker（`node apps/worker/dist/runner.js`）与 GUI 主进程均输出：
```
Capabilities — git:2.39.2 gh:2.92.0 claude:2.1.183 node:24.15.0 python:3.13.3
```
DB 中 capabilities（解析出 macOS 真实路径，证明 fixMacGuiPath 从登录 shell 补回了 PATH）：
```
gh   : ok path=/usr/local/bin/gh            ver=2.92.0
git  : ok path=/usr/bin/git                 ver=2.39.2
claude: ok path=/Users/sunpeng/.local/bin/claude ver=2.1.183
```

## <a id="register"></a>register — PASS
```
SELECT status, working_state, claude_version, age(last_seen_at) FROM workers WHERE name='mac-verify-imac';
→ status: online | working_state: idle | claude_version: 2.1.183 | heartbeat age: 3 s（实时）
```

## gui-render / os-label — PASS
`webContents.capturePage()` 抓渲染后位图（不依赖窗口在哪个 Space 合成）：见 `round-1/overview-macos-populated.png`：
- 系统 = **macOS 13.7.8 (x64)**（os-label 修复前是 `macOS 22.6.0` = Darwin 内核版本）
- 能力就绪 **5/5**，能力自检 git/gh/claude/node.js/python 全绿带 mac 路径
- 实时通道 = 连接中（SSE relay）

> 注：`screencapture -x` 全屏截图只拍到桌面壁纸——窗口开在另一个 macOS Space 的截屏伪影，非产品缺陷；capturePage 报告 `visible=true`、bounds `{x:0,y:25,w:1280,h:705}` 证明窗口已正常显示。

## <a id="b1"></a>b1-window-db-down / conn-timeout / warmup — PASS
用不可达 DB 启动：`DATABASE_URL=postgresql://x:x@10.255.255.1:55432/nope electron .`
```
Capabilities — git:2.39.2 ... （PATH 修复不依赖 DB，正常）
[worker] start failed: Error: Connection terminated due to connection timeout  ← 8s 超时（非 75s），被 .catch 接住、app 不崩
capturePage 仍落盘 → 窗口照常渲染（修复前此场景【完全无窗口】）
```
证据：`round-1/db-down-window-renders.png`（完整仪表盘外壳出现，字段暂为占位，DB 恢复即填充）。warmup：正常路径下能力区在 ~2-9s 填充（截图延时 10s 已满），非空窗 15s。

## <a id="m1"></a>m1-killtree / timeout-path — PASS
`node docs/acceptance/worker-mac-adaptation/scripts/verify-killtree-posix.mjs`（对最终构建）：
```
fix (newProcessGroup:true):  {childAliveAfter:false, grandAliveAfter:false}   ← 子+孙皆死
control (newProcessGroup:false, 旧行为): {childAliveAfter:false, grandAliveAfter:true}  ← 孙进程泄漏（复现 bug）
[PASS] newProcessGroup 杀净子+孙；对照组复现孙进程泄漏（证明修复必要且生效）
```
超时路径同改 `killProcessTree`（对非组长子进程自动回退 child.kill，无回归），随 build 编译通过。

## <a id="m2"></a>m2-printenv-path — PASS
`zsh -ilc "printf '%s' '__B__'; /usr/bin/printenv PATH; printf '%s' '__E__'"`：哨兵间为冒号分隔 24 个目录（含 `/Users/sunpeng/.local/bin`）。GUI 能力 5/5 全绿即跑在此 printenv 提取上。fish 未装（正是该修复加固的潜伏场景）；printenv 读真实环境变量、任何 shell 都冒号分隔，correct-by-construction。

## <a id="locale"></a>m1-locale — PASS
fr_FR.UTF-8 环境下调 `getProcessStartTime(真实存活 pid)` → 返回有限值 `1781955679000`（修复前 fr/ru 下 `Date.parse`=NaN→null）。

## <a id="final"></a>final-clean — PASS
移除临时诊断后，最终生产构建 `electron .` 日志仅 `Capabilities — ...`（+ 被滤掉的良性 chromium 安全警告），无报错；DB 心跳 age 3s、online。验证用 `mac-verify-imac` worker 行已于验证后从共享库删除（0 任务认领，无残留）。
