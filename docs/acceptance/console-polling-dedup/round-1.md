# Round 1 — 修复验证（真实浏览器）

- 环境：`next dev --turbopack`（Next 15.5.19）于 `127.0.0.1:3010`；驱动 = playwright-core 1.61 跑系统 Chrome 149（真实浏览器，录 HAR）。
- **relay 实测为「启用」**（`/api/relay/ticket` 返回 `enabled:true, url:http://127.0.0.1:8787`，本机有 relay 服务在跑、累计 2794 事件）——与用户环境一致，属"有事件流入"的真实压力条件。
- 会话：用 `@claude-center/db.createSession` 给 admin 免密发 token，注入 `cc_session` cookie。
- 脚本：`scripts/probe-polling.mjs`（预热各路由 → 首页停留量通知节奏 → 软点侧边栏依次切页量初始化重复）、`scripts/analyze.mjs`（统一口径：同接口 <300ms 重复 = 真·二重挂载特征）。
- 产物：`round-1/<label>/{timeline.json,analysis.json}`（蒸馏证据，入库）、`round-1/diag-nonav-strictoff.txt`（定位过程原始日志）。原始 `session.har` 体积达数十 MB，**已 gitignore 不入库**，需要时按 `report.md` 配方用 `probe-polling.mjs` 重生成（脚本现用 `recordHar: minimal`）。

## 根因（实测确认）

### 问题1：/api/notifications 不按 15s、频率过快且不固定
- `usePolling` 默认 `relay:true`，通知组件订阅 relay 快线。relay 启用且有事件流入时，**项目频道每条事件**（消息流 / worker 心跳 / 任务状态）都经 200ms 去抖后触发一次 `run("relay")`，把通知拉取打成不规则高频。
- 定位证据 `diag-nonav-strictoff.txt`（给 `run()` 加 `why` 来源标记，纯首页静置 50s）：通知与 dashboard 反复以 `why=relay` 同时发火（+14.29 / +24.97 / +29.30 / +44.31 / +59.31s，不规则）；真正的 `why=interval` 恰好 15s（+35.19 → +50.18）。即「15s 定时器本身没问题，是 relay 事件在加塞」。

### 问题2：切页初始化接口调用两遍
- **React StrictMode**（Next 15 dev 默认开）在「客户端导航后挂载组件」时把 effect 跑两遍（mount→cleanup→mount），每个 `usePolling` 的首次 `run("mount")` 各发一次 → 同接口两发。
- 关键反证：**初次硬加载/水合时只发一遍**（effect 只跑一次），仅"软切页后挂载"才两遍——排除"组件自身重复渲染"，锁定 StrictMode 客户端导航双调用。决定实验：`reactStrictMode:false` 后软切页 workers/tasks/projects 各只发一遍。

## 修复
- `apps/console/app/ui/notifications.tsx`:146 — `usePolling(refresh, [], 15000, { relay: false })`：通知固定 15s，不被 relay 事件加塞（通知非亚秒级需求，下一轮轮询补齐）。
- `apps/console/next.config.mjs` — `reactStrictMode: false`：关闭 dev 客户端导航的 effect 双调用（生产构建本就不触发；usePolling 自带 cleanup、不靠 StrictMode 排错）。

## 证据（before vs after，同一脚本/同一 relay 启用条件）

`node scripts/analyze.mjs round-1/<label>/timeline.json` 输出：

| 维度 | before（修复前） | after（修复后） |
|---|---|---|
| 通知 home-dwell 间隔(s) | `[2.56, 12.45, 2.56, 11.72, 1.02, 2.25, 12.45, 5.04]` 不规则、多 <10s | `[16.25, 15.00, 15.01, 14.99]` 稳定 15s |
| nav /tasks 同接口<300ms 重复 | `workers Δ5ms; tasks Δ2ms; projects Δ2ms` | 无重复 |
| nav /chat | `projects Δ1ms; workers Δ1ms` | 无重复 |
| nav /workers | `workers Δ1ms` | 无重复 |
| nav /projects | 无重复 | 无重复 |
| nav /（home） | `relay/connections Δ1ms` | 无重复 |

- before 的重复全是 **Δ1–5ms**（同帧同步双发）——StrictMode 二重挂载的铁证；relay/interval 触发的二次刷新都在秒级，不会落进 300ms 窗。
- after 全 timeline **无任何接口在 300ms 内重复**（脚本扫描确认 0 命中）；home 窗口内 `/api/dashboard` 的第二次在 **+3.44s**（mount + 1 次 relay 刷新，dashboard 仍按设计走快线），非二重挂载。

## 结论
notif-cadence、nav-no-dup、app-boots 三项 PASS（见 matrix.csv）。两问题均在真实浏览器、relay 启用的真实条件下验证修复。
