# console 轮询节奏 & 页面初始化重复请求修复

## 症状（来自用户提供的 `docs/tmp/localhost.har`）

1. **`/api/notifications` 不按 15s 间隔**：配置是 `usePolling(refresh, [], 15000)`，但 HAR 实测稳态（+26s 后无导航）呈 ~5s 周期：`26.89 → 31.89 → 36.88 → 41.88`，且夹杂额外调用，频率过快且不固定。
2. **切换页面初始化接口调用两遍**：HAR 中
   - `+6.86/6.87s` `/api/dashboard` ×2
   - `+8.88s` `/api/relay/connections` ×2
   - `+23.50s` `/api/workers`、`/api/tasks`、`/api/projects` 各 ×2（导航到 /tasks）
   - `+30.34s` `/api/projects`、`/api/workers` 各 ×2（导航到 /chat）

   两两时间戳相差 ~10ms，是 React StrictMode（Next 15 `next dev` 默认 `reactStrictMode:true`）effect 二次执行的典型特征。用户称已让修复三次未果。

## 根因（已实测确认 → 详见 round-1.md）

- **重复请求 = React StrictMode**（Next 15 dev 默认开）。它只在「客户端软导航后挂载组件」时双调用 effect；初次硬加载/水合只跑一遍（这是关键反证，排除组件自身重复渲染）。生产 `build`/`start` 不触发，"build 绿"是假信号。修复：`reactStrictMode:false`。
- **通知过快 = relay 快线加塞**，与 5s 周期/多 poller 的猜测无关。`usePolling` 默认订阅 relay，relay 启用且有事件流入时每条频道事件都触发一次通知刷新；15s 定时器本身正常（`why=interval` 实测恰好 15s）。修复：通知 `usePolling(..., { relay:false })`。

## 验证手段

真实浏览器（playwright-core 驱动系统 Chrome）跑 `next dev`，录制 HAR + 请求时间线：
- `scripts/mint-session.mjs`：用 `@claude-center/db.createSession` 给 admin 发会话 token（免密码）。
- `scripts/probe-polling.mjs`：注入 cookie → 预热各路由（去掉首编译噪声）→ 首页停留 35s 量通知周期 → 依次导航量初始化重复 → 输出 `timeline.json` + 分析。

## 验收口径（matrix.csv）

- notif-cadence：稳态通知相邻间隔 ∈ [13s, 17s]（15s±2s），无 <10s 的密集调用。
- nav-no-dup：每次导航后窗口内，每个初始化接口（method+path+query）出现次数 = 1。
