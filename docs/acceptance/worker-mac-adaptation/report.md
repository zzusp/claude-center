# 验收报告 — 桌面 Worker macOS 适配（全绿）

**结论**：桌面 Electron Worker 已在本机（Intel macOS 13.7.8）真机验证通过。`matrix.csv` 15/15 PASS。代码层 Mac 适配（PR #122）此前已就位，本轮真机跑起来后又抓出并修复了 1 个 blocker + 2 个 major + 3 个小问题。

## 修复清单（均已本机回归，见 round-1.md）

- **B1 [blocker] 窗口被 DB 卡死**：`main.ts` 改为窗口先建、`worker.start()` 非阻塞 + `.catch`；`getPool` 加 `connectionTimeoutMillis:8000`；窗口先于 start() 渲染后用冷启动快轮询补齐能力区。→ DB 不可达也能出窗口（符合安装手册 §11），死主机 8s 失败而非 ~75s。
- **M1 [major] 取消泄漏 Claude 进程树**：`shell.ts` 新增 `newProcessGroup`（进程组组长但保留管道 stdio、不 unref），`executor.ts` 任务/终端形态 POSIX 置真；超时路径改 `killProcessTree`。→ 取消/超时杀净 claude 及其 git/gh/npm/MCP/子代理，不再泄漏（对照组验证旧行为确实泄漏）。
- **M2 [major] fish PATH 损坏**：`mac-path.ts` PATH 提取改 `/usr/bin/printenv PATH`（任何 shell 冒号分隔）。
- **m1 [minor] locale**：`getProcessStartTime` 的 ps 强制 `LC_ALL=C`。
- **m2 [minor]**：启动 spawnSync 超时 8s→5s。
- **显示**：`inspect.ts` 用 `sw_vers` 显示 macOS 产品版本（13.7.8）而非 Darwin 内核版本（22.6.0）。

## 影响面

- 改了共享包 `packages/db/client.ts`（加连接超时，加性安全）→ 已全量 typecheck/build 验证 console/relay/worker 均编译通过。
- `shell.ts`/`executor.ts` 进程管理是核心执行路径，Windows 路径（taskkill /T、shell:true npm）未触碰；`newProcessGroup` 仅 POSIX 置真，Windows 行为不变。

## 延后项

- **m3 mac app 图标**：当前打 dmg 会用 electron 默认火箭图标（纯外观，build/run 不受影响）。需 `apps/worker/build/icon.icns`（1024×1024 源图转 icns），electron-builder 经 `directories.buildResources` 自动识别；建议同时给 `scripts/dist-check.mjs` 加 icon 存在性检查防漏。本轮未做（需设计资产）。

## 复现配方

```bash
# 依赖（electron 二进制走镜像，直连 github 被本网络挡）
ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/ npm install
npm run build
# headless 跑通 worker 运行时（注册/心跳/能力，需 apps/worker/.env 的 DATABASE_URL）
node apps/worker/dist/runner.js
# GUI
npm -w @claude-center/worker run dev   # 或 (cd apps/worker && ../../node_modules/.bin/electron .)
# M1 进程树 kill 回归（带对照组）
node docs/acceptance/worker-mac-adaptation/scripts/verify-killtree-posix.mjs
```

> macOS GUI 窗口验证小技巧：`screencapture -x` 全屏可能因 Space 切换拍不到窗口；用 `webContents.capturePage()` 抓渲染位图最可靠（不依赖合成 Space）。
