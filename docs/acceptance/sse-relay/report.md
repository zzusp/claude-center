# SSE 中转服务（Phase 1）验收报告 — 全绿

分支：`worktree-sse-relay`。`matrix.csv` 全部 PASS（C1–C12），证据见 `round-1.md`。

## 结论

Phase 1（SSE 转发 + 消息落库）已落地并自验证通过：

- **新服务 `apps/relay` + 共享包 `packages/relay-client`**：自验证 6 项全过（投递 / 保活 / Last-Event-ID 重放 / 鉴权拒绝 / ticket 频道过滤 / healthz）。
- **Worker 集成**：WorkerRelay 经真实 relay 收到 console 事件、忽略自身事件（origin 过滤）e2e 通过；订阅信号驱动即时 tick；各生命周期点落库后发布。
- **Console 集成**：8 个 mutating route 落库后 best-effort 发布；`/api/relay/ticket` 按 RBAC 签发短时效票据；`use-relay` 共享单连接叠加进 `usePolling`，全站页面零改动即变实时。
- **无回归**：五包 typecheck/build 全绿；`verify:console`（relay 禁用、纯轮询）401→登录→200 通过。
- **默认安全**：`CLAUDE_CENTER_RELAY_URL` 为空时整体退回纯轮询，与启用前行为一致。

## 复现

```powershell
npm run typecheck
npm run build
npm -w @claude-center/relay run selftest
node docs/acceptance/sse-relay/scripts/worker-relay-e2e.mjs
node apps/relay/dist/main.js --check
npm run verify:console            # 需 DATABASE_URL + 已 db:migrate（worktree 冷启动就绪可能 >30s）
```

## 遗留（Phase 2 TODO）

DB 轮询双线择优降级（中转健康时慢化轮询、断时恢复）、reconnect→DB 全量对账、relay 端按 worker_project_links 校验订阅授权、多 relay 实例广播背板、session jsonl 流式推送。详见 `docs/spec/sse-relay-service.md` §8/§10/§12。
