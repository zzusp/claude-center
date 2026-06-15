# SSE 连接状态展示（Web Console + 桌面 Worker）

## 需求

让 **Web 端**（`apps/console`）和**桌面端**（`apps/worker`）都直观显示 SSE 中转（relay）的连接状态 / 连通性。当前两端都把连接状态藏在内存里（console 的 `use-relay.ts` 全局变量、worker 的 `WorkerRelay.connected` 私有布尔），用户看不到「实时快线是否在用」，也分不清「正在轮询兜底」还是「SSE 已连通」。

## 现状（已读源码）

- relay 是「DB 唯一权威 + 双向轮询」之上叠加的低延迟线：可用走 SSE（亚秒级），不可用退回 DB 轮询，功能不降级。
- **relay-client**（`packages/relay-client`）`subscribeRelay()` 只暴露 `onOpen` / `onError` 回调 + `close()`，无状态枚举。本次**不改** relay-client——两端各自在应用层组装状态机即可，避免给共享包加面向 UI 的状态接口。
- **console**：`app/lib/use-relay.ts` 用原生 `EventSource`，`connect()` 取 ticket → 建连，`es.onopen` / `es.onerror` / 失败重连齐全；只 `registerRelayListener`（事件）对外，无状态出口。顶栏 `shell.tsx` 已有 `SyncStatus`（DB 轮询心跳），`shared.tsx` 有 `StatusBadge/StatusDot/Tone`，`globals.css` 有 `.sync`/`.dot[data-tone]` 样式。
- **worker**：主进程 `src/relay.ts` `WorkerRelay` 有 `private connected`（仅内部用，66–73 行），`getStatusSnapshot()`（`runner.ts`）不含 relay 状态；IPC 走 `workerApi.getState()` → `getStatusSnapshot()`。UI 是 `main.ts` 内联 HTML，品牌区 `brand-sub` 有个**恒定脉冲**的 `.live-dot` + 硬编码「连接中…」。

## 状态模型（两端统一语义）

```
disabled      未配置 relay（URL 空）/ 无可订阅频道 → 纯轮询
connecting    首次建连中（尚未 open 过）
connected     SSE 流已打开
reconnecting  曾连通后断开，退避重连中
```

UI 配色（复用现有 tone）：connected→success(绿,脉冲) / connecting→running(蓝) / reconnecting→pending(琥珀) / disabled→cancelled(灰)。

## 改动

### relay-client
不改。

### console（`apps/console`）
1. `app/lib/use-relay.ts`：新增 `RelayStatus` 类型 + 模块级 `status` + `setStatus()` 通知；导出 `getRelayStatus()`、`registerRelayStatusListener()`、React hook `useRelayStatus()`。状态迁移挂在既有生命周期点：`es.onopen`→connected；`scheduleReconnect()`→connecting/reconnecting（按是否 everOpen 区分）；ticket 未启用→disabled。
2. `app/ui/overview.tsx`：新增并导出 `RelayStatus` 展示组件（仿 `SyncStatus`，dot+文案）；`RuntimeHealth` 卡片区把「实时同步」卡补上 SSE 行 / 或并列展示 relay 状态。
3. `app/ui/shell.tsx`：顶栏 `topbar-actions` 在 `SyncStatus` 旁加 `RelayStatus`（全站每页可见）。

### worker（`apps/worker`）
1. `src/relay.ts`：`connected` 布尔 → `status: RelayStatus` 状态机；导出 `RelayStatus` 类型；加 `get state()` / `get channelCount()`。迁移点：subscribe()→connecting；onOpen→connected；onError→reconnecting；stop()/未配置→disabled。
2. `src/runner.ts`：`WorkerStatusSnapshot` 加 `relayState: RelayStatus` + `relayChannels: number`；`getStatusSnapshot()` 填充。
3. `src/main.ts`：品牌区 `brand-sub` 的 live-dot 改为 relay 指示器（按 state 着色 + 仅 connected 脉冲），加 `#relay` 文案；`refresh()` 据 `s.relayState` 更新。`preload.cjs` 无需改（`getState()` 自动透传新字段）。

## 验证

- `npm run typecheck`（五包）+ `npm run build`。
- `npm run verify:console`（401→200，确认 instrumentation/中间件未受影响）。
- worker：`tsx` 脚本对 `getStatusSnapshot()` 断言含 `relayState`/`relayChannels`；relay 状态机用 stub 触发 onOpen/onError 验证迁移。
- 配 relay 时人工核对两端指示器随连/断切换。
