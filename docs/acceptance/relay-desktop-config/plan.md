# 桌面端支持配置 SSE 中转服务地址

## 需求
此前 Worker 的 SSE 中转配置（`CLAUDE_CENTER_RELAY_URL` + 发布/订阅 token）仅能经环境变量 /
`~/.claude-center/.env` 手改，打包分发的桌面端用户改起来不便。目标：在桌面端「设置」里直接配置
中转服务**地址**（及其鉴权 token），保存即时生效、跨重启保留。

## 方案
沿用既有「运行终端」卡片的成熟模式：UI 文本输入 + 保存按钮 → IPC → runner 改内存 + 持久化
`worker.json` + 运行时即时应用。中转要连通需地址 + 发布 token + 订阅 token 三者（仅地址无 token
则 `subscribe()` no-op、`publish` 鉴权失败），故三项一并纳入，地址为头部主字段。

- **持久化优先级**：`worker.json` 设过即覆盖同名 env（与 `terminalCommand`/`claudePreCommand` 同）；
  清空保存 = 显式禁用（不回退 env）。
- **运行时热重配**：`WorkerRelay.reconfigure()` 按最新 config 重建发布器 + 断旧订阅清频道，
  随后 `refreshLinkedProjects()` 按新配置重订阅，无需重启。

## 改动
- `apps/worker/src/config.ts`：`WorkerState` 增 `relayUrl`/`relayPublishToken`/`relayWorkerToken`；
  `readWorkerConfig` 改为 `state.X ?? (env || "")`。
- `apps/worker/src/relay.ts`：`publisher` 改可变 + 新增 `reconfigure()`。
- `apps/worker/src/runner.ts`：新增 `setRelayConfig()`；快照暴露当前 relay 配置供回显。
- `apps/worker/src/main.ts` + `preload.cjs`：新增 `worker:setRelayConfig` IPC 通道。
- `apps/worker/src/window-html.ts`：「设置」页新增「SSE 中转服务」卡片（地址 + 两 token + 保存）
  + `loadRelay()` 回显 + 保存处理。
- `docs/manual/worker-install-guide.md` §5.3：补桌面端配置法。

## 验证
- `npm run typecheck`：五包全绿。
- `npm -w @claude-center/worker run build`：worker dist 编译绿。
- `node docs/acceptance/relay-desktop-config/scripts/verify-relay-config.mjs`：14 项断言全 PASS
  （env 来源 → 持久化覆盖 → 清空禁用 → `reconfigure` 热生效），见 `round-1.md`。
- 渲染 `windowHtml()` 含新元素（relayUrl / saveRelay / setRelayConfig / loadRelay / 「SSE 中转服务」）。

> Electron GUI 无法在 headless worker 实跑，故验证收敛到非 GUI 核心逻辑（config 持久化优先级 +
> 运行时 reconfigure）+ HTML 产物完整性；GUI 交互沿用与「运行终端」卡片完全同构的成熟链路。
