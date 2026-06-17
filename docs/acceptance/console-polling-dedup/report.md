# 报告 — console 轮询节奏 & 切页重复请求修复

状态：**全绿**（matrix.csv 三项 PASS），真实浏览器验证通过。

## 两个问题 & 修复

| 问题 | 真因（实测） | 修复 | 证据 |
|---|---|---|---|
| `/api/notifications` 不按 15s、频率过快且不固定 | `usePolling` 默认订阅 relay 快线；relay 启用且有事件流入时，项目频道每条事件都加塞一次通知刷新 | `notifications.tsx`: `usePolling(refresh, [], 15000, { relay:false })` | 间隔 `[2.56,12.45,…]`→`[16.25,15.00,15.01,14.99]` |
| 切页初始化接口各调两遍 | React StrictMode（Next 15 dev 默认）客户端导航挂载时 effect 双调用 | `next.config.mjs`: `reactStrictMode:false` | 软切页 `<300ms` 同接口重复 多→0 |

## 验证方式
playwright-core 驱动系统 Chrome 跑 `next dev`，录 HAR + 请求时间线，relay 启用（与用户环境一致）。before/after 同脚本对比，见 `round-1.md`。

## 复现
```powershell
$env:CONSOLE_PORT="3010"; node scripts/dev-console.mjs          # 起 dev
$env:BASE_URL="http://127.0.0.1:3010"
node docs/acceptance/console-polling-dedup/scripts/probe-polling.mjs --label after --home-dwell 50
node docs/acceptance/console-polling-dedup/scripts/analyze.mjs docs/acceptance/console-polling-dedup/round-1/after/timeline.json
```
> 探针依赖 `playwright-core`（已 `npm i --no-save`，不入 package.json）。

## 影响 & 取舍
- 通知 `relay:false`：通知最迟 15s 内刷新（非亚秒级），通知非时效敏感、可接受；chat/tasks 等仍走 relay 快线不受影响。
- `reactStrictMode:false`：仅影响 dev（生产本就不双调用）；本应用 usePolling 自带 cleanup、不依赖 StrictMode 排错。如需保留 StrictMode 的 dev 检查可改回，但 dev 会重现切页双发。

## 反馈（未改，按"代码精确编辑"原则只提不动）
- `dashboard-client.tsx` 的总览轮询同样订阅 relay，relay 启用时也会被事件加塞（home 窗口实测 dashboard 第二发在 +3.44s = relay 刷新）。用户只反馈了通知，故未动 dashboard；如也想让总览稳定 15s，可同样加 `{ relay:false }`。
