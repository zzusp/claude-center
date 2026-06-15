# 验收：SSE 连接状态展示（Console + Worker）

## 需求
Web 端（`apps/console`）与桌面端（`apps/worker`）都直观显示 SSE 中转（relay）连接状态 / 连通性，与「DB 轮询」心跳并列，让用户一眼区分实时快线是否在用。设计见 `docs/spec/sse-connection-status.md`。

## 改动
- `packages/relay-client`：不改（两端各自在应用层组装状态机）。
- **console**
  - `app/lib/use-relay.ts`：新增 `RelayStatus` 类型 + 状态机（`es.onopen`→connected；`scheduleReconnect`→connecting/reconnecting；ticket 未启用→disabled），导出 `getRelayStatus` / `registerRelayStatusListener` / `useRelayStatus`。
  - `app/ui/overview.tsx`：`RELAY_META` 配色映射 + `RelayStatus` 顶栏指示器（导出）；`RuntimeHealth`「实时同步」卡补「SSE 中转」行。
  - `app/ui/shell.tsx`：顶栏 `topbar-actions` 并入 `<RelayStatus/>`（全站每页可见）。
  - `app/globals.css`：`.relay-inline` 行内 dot+文案对齐。
- **worker**
  - `src/relay.ts`：`connected` 布尔 → `status: RelayStatus` 状态机（subscribe→connecting；onOpen→connected；onError→reconnecting；stop/未配置→disabled），导出类型 + `get state()` / `get channelCount()`。
  - `src/runner.ts`：`WorkerStatusSnapshot` 加 `relayState` / `relayChannels`，`getStatusSnapshot()` 填充。
  - `src/main.ts`：品牌区 live-dot 改为 relay 指示器（按 state 着色 + 仅 connected 脉冲）+ `#relay` 文案；`refresh()` 据 `s.relayState` 更新。`preload.cjs` 自动透传，无需改。

## 验证（一轮全绿）
| 项 | 命令 | 结果 |
|---|---|---|
| 五包 typecheck | `npm run typecheck` | PASS |
| 五包构建(含 next build) | `npm run build` | PASS |
| dev 健康(instrumentation/中间件未受损) | `npm run verify:console` | PASS：unauthDashboardStatus=401 / loginStatus=200 / pageStatus=200 / EXIT=0 |
| worker relay 状态机(disabled/connecting/channelCount/stop) | `node docs/acceptance/sse-connection-status/scripts/verify-worker-relay.mjs` | PASS：RESULT ALL PASS |
| worker relay e2e(connected→reconnecting) | `node docs/acceptance/sse-connection-status/scripts/verify-worker-relay-e2e.mjs` | PASS：RESULT ALL PASS |

> 脚本需先 `npm -w @claude-center/worker run build`（导入 `apps/worker/dist/relay.js`）。

## 备注
- worker 端「连通后断流」：subscribe.ts 内部 `scheduleReconnect`（不回调 onError），下一次重试失败才 onError→reconnecting，故断后会先短暂保持 connected，再转 reconnecting（已在 e2e 中复现验证）。console 端原生 EventSource `onerror` 即时触发，转换更快。两端 disabled 为未配置 relay 时的纯轮询兜底态。
- 配齐 `CLAUDE_CENTER_RELAY_*` 起 `npm run dev:relay` 后，人工核对两端指示器随连/断切换（连接中→已连通→重连中）。
