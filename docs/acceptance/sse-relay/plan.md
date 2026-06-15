# SSE 中转服务（Phase 1）验收方案

## 需求

在「PostgreSQL 唯一权威 + 双向轮询」之上叠加一条独立的 SSE 中转服务，让 Console↔Worker 通信在中转可用时走实时推送、不可用时退回数据库轮询（双线）。本期（Phase 1）落地 **SSE 转发 + 消息落库**；DB 轮询双线择优降级列为 Phase 2 TODO。方案见 `docs/spec/sse-relay-service.md`。

## 方案要点

- 新增独立服务 `apps/relay`（Node `http`，仅依赖 `packages/relay-client`，DB 无关）：`/events`（SSE 订阅，ticket/worker token 鉴权、保活 ping、Last-Event-ID 短重放）、`/publish`（publish token 鉴权、扇出）、`/healthz`。
- 新增共享包 `packages/relay-client`：事件契约（含 `origin` 防自触发）+ HMAC 票据签发/验签 + Node 发布 helper + Node SSE 订阅 helper（重连退避/保活/断线检测/Last-Event-ID）。
- Console：`/api/relay/ticket` 按 RBAC 签发短时效票据；`app/lib/relay-publish.ts` 在各 mutating route **落库后** best-effort 发布；`app/lib/use-relay.ts` 用原生 EventSource 共享单连接订阅，叠加进 `usePolling`（全站页面零改动即变实时，轮询继续兜底）。
- Worker：`apps/worker/src/relay.ts` 订阅 `worker:<id>` + 本机 `project:<id>`，收到非自身事件即催一次相应 tick；各生命周期点（认领/完成/对话轮/取消/心跳/工作态）落库后发布。

## 改动清单（关键 `file:line`）

- 新增：`packages/relay-client/src/{events,ticket,publish,subscribe,index}.ts`
- 新增：`apps/relay/src/{config,env,server,main}.ts` + `apps/relay/scripts/selftest.mjs`
- 新增：`apps/console/app/lib/{relay-publish,use-relay}.ts`、`apps/console/app/api/relay/ticket/route.ts`
- 新增：`apps/worker/src/relay.ts`
- 改：`apps/console/app/lib/use-polling.ts`（叠加 relay 监听）
- 改：Console 8 个 mutating route（落库后 `publishRelay`）：`conversations/route.ts`、`conversations/[id]/messages/route.ts`、`tasks/route.ts`、`tasks/[id]/route.ts`、`tasks/[id]/comments/route.ts`、`tasks/[id]/review/route.ts`、`direct-commands/route.ts`、`workers/[id]/working-state/route.ts`
- 改：`apps/worker/src/{config,runner}.ts`（relay 配置 + 订阅驱动即时 tick + 发布）
- 改：根/各包 `package.json`（构建串联 + 依赖）、`.env.example`、`README.md`、`CLAUDE.md`

## 验证项

见 `matrix.csv`。自动化证据：relay 自验证（6 项）+ WorkerRelay 集成 e2e（2 项）+ `--check` + 全量 typecheck/build + `verify:console`（relay 禁用，无回归）。

## 边界（本期未做，Phase 2）

- DB 轮询双线择优（中转健康时慢化轮询、断时恢复）；reconnect→DB 全量对账；relay 端按 worker_project_links 校验订阅授权；多 relay 实例广播背板；session jsonl 流式推送（现走 3s 轮询）。
