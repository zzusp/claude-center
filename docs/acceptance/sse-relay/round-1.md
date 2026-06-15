# Round 1 — 验证记录（全绿）

环境：Windows 11 / PowerShell 7 / Node v22.13.0 / worktree `worktree-sse-relay`。

## C1–C6 relay 自验证（`npm -w @claude-center/relay run selftest`）

```
  [1] 投递 OK（id=1, type=task.upserted）
  [2] 保活 OK（700ms 内无误断）
  [3] Last-Event-ID 重放 OK（补回 2 条 id>1）
  [4] 鉴权 OK（无票据/无 token → 401）
  [5] ticket 频道过滤 OK（allowed 投递、denied 被拒）
  [6] /healthz OK（events=5, clients=2）

relay selftest: ALL PASS ✅
```

脚本：`apps/relay/scripts/selftest.mjs`（起 ephemeral relay，用真实 publish/subscribe 走真 TCP）。

## C7–C8 集成 e2e（`node docs/acceptance/sse-relay/scripts/worker-relay-e2e.mjs`）

用真实 `WorkerRelay`（`apps/worker/dist/relay.js`）+ console 同款 `createPublisher` 对 listening relay 跑：

```
relay e2e: PASS ✅（worker 收到 1 条外部信号、忽略了自身事件）
```

- C7：console 发到 `project:P1` → Worker 订阅收到（`entityId=T1, origin=console`）。
- C8：Worker 自己 publish（`origin=W1`）→ 其订阅按 origin 过滤忽略（防自触发循环）。

## C9 relay --check（`node apps/relay/dist/main.js --check`）

零副作用：打印脱敏配置（密钥仅显示 `set(N chars)` / `MISSING`）、未配置密钥时 warn、退出 0，不监听端口。

```
{ "check": true, "config": { "host": "127.0.0.1", "port": 8787, "secret": "MISSING", ... } }
[relay] 警告：以下密钥未配置 ... CLAUDE_CENTER_RELAY_SECRET, ...PUBLISH_TOKEN, ...WORKER_TOKEN
```

## C10 全量 typecheck（`npm run typecheck`）

db / relay-client / console / worker / relay 五包 `tsc --noEmit` 全部无错误。

## C11 全量 build（`npm run build`）

五包构建成功，含 `next build`（console 路由表正常输出，含 `/api/workers/[id]/working-state` 等）。

## C12 verify:console（`npm run verify:console`，relay 禁用）

`.env` 未配 `CLAUDE_CENTER_RELAY_*`（中转禁用、纯轮询）。断言通过：未登录 `/api/overview` → 401；`admin/admin123` 登录拿 `cc_session`；带 cookie → 200，`health.db.ok=true`、scheduler 正常。证明叠加中转后纯轮询路径无回归。

> 注：worktree 冷启动 `next dev` 编译 + 远程共享库握手偶尔超过脚本默认 30s 就绪窗口；本轮临时放宽到 90s 跑通后**已还原** `scripts/verify-console.mjs` 为 30s（不进 PR）。属环境计时、非代码问题。

## 未覆盖（Phase 2 / 需真集群）

- 启用中转下 Console+Worker+DB+claude 的真实链路端到端（任务秒级认领 / 对话秒级回显）——需在线 Worker + claude，留待联调。本轮以 relay 自验证 + WorkerRelay 集成 e2e + 全量构建/verify 覆盖核心正确性。
