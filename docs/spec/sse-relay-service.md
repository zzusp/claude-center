# SSE 中转服务（Realtime Relay）方案

> 在现有「DB 唯一协调中心 + 双向轮询」之上，叠加一条独立的低延迟 **SSE 中转服务**（`apps/relay`），让 Console 与 Worker 之间的通信在中转可用时走实时推送、不可用时退回数据库轮询（双线择优）。
>
> 本方案经评审确认后再落地编码。决策基线（已与用户对齐）：
> - **承载方式**：传**全量消息负载**（SSE 直接携带消息/状态全文，DB 仅作持久备份与对账锚）。
> - **部署形态**：**独立服务** `apps/relay`（单独端口/部署），Console 与 Worker 都连它。
> - **分期**：本期（Phase 1）优先 **SSE 转发 + 消息落库**；**DB 轮询降级线（Phase 2）定为 TODO**。
> - **硬约束**：所有消息/状态**必须先落库**再 publish——落库是持久化与对账的锚点，使 best-effort 的 SSE 即便丢包也无数据丢失。

## 1. 背景与现状

当前架构是**纯轮询、零推送**（全仓无 `EventSource` / `text/event-stream` / `WebSocket`，MVP 文档明确「不引入 WebSocket」）：

- **Console（浏览器）**：统一 `usePolling`，`POLL_INTERVAL_MS=3000`（`apps/console/app/lib/use-polling.ts:6`）打 `/api/*` 拉 DB。
- **Worker（Electron）**：主 tick 10s 认领、心跳 15s、取消扫描 3s、对话 3s（`apps/worker/src/runner.ts`、`config.ts`）。
- **拓扑**：Console 直连 DB、Worker 直连 DB，**两者之间无任何直接通信**，全靠 PostgreSQL 当唯一协调中心；Worker 不对 Console 发 HTTP。
- **鉴权**：Console 用 cookie session（`cc_session`）+ 项目级 RBAC；Worker 仅凭 `DATABASE_URL` 直连、无逐 Worker 凭据。
- Console 进程 `instrumentation.ts` 已跑后台循环（定时发布、合并检查），有已知 edge-runtime/webpack 坑。

**问题**：轮询带来 3–10s 延迟，体验不实时（任务认领、对话回复、状态翻转都要等下一轮）。

**目标**：新增实时线把延迟降到亚秒级，且**不破坏现有架构**——DB 仍是权威，轮询仍是兜底，relay 只是「更快的那条线」。

## 2. 总体架构

```
                         ┌───────────────────────────┐
                         │     apps/relay (新增)      │
   ticket (RBAC scoped)  │  独立 Node SSE 中转服务     │
  ┌──────────────────────┤  - GET  /events  (SSE 订阅)│
  │                      │  - POST /publish (发布)    │◄────────────┐
  │   SSE 订阅            │  - GET  /healthz           │   POST 发布  │
  │   (EventSource)       │  内存 pub/sub + 频道 ring  │   (落库之后) │
  │                      └─────────────┬─────────────┘             │
  │                                    │ SSE 推送                   │
┌─┴──────────────┐   /api/relay/ticket │              ┌────────────┴──────────┐
│ Console 浏览器 │◄───────────────────┐│              │   Worker (Electron)   │
│  use-relay hook│                    ││              │  relay-client 订阅+发布│
└────────────────┘                    ││              └────────────┬──────────┘
        ▲                    ┌─────────┴┴──────────┐                │
        │ 现有 /api 轮询(兜底)│   Console 服务端     │                │
        └────────────────────┤  - API route 落库    │                │
                             │  - 落库后 publish    │                │
                             │  - 签发 ticket        │                │
                             └──────────┬───────────┘                │
                                        │                            │
                                ┌───────▼────────────────────────────▼───────┐
                                │            PostgreSQL（唯一权威）           │
                                │  写路径：先落库 → 再 publish（best-effort） │
                                └─────────────────────────────────────────────┘
```

**两条线**：
1. **快线（本期）**：写方落库后把全量负载 POST 给 relay，relay 扇出给订阅者，订阅者直接消费负载更新 UI/状态。
2. **慢线（兜底，Phase 2 显式择优；Phase 1 沿用现有轮询作隐式兜底）**：订阅者按现有节奏轮询 DB；relay 不可用时不受影响。

## 3. 组件与代码落点

| 组件 | 位置 | 职责 | 本期/TODO |
| --- | --- | --- | --- |
| **Relay 服务** | `apps/relay`（新增 app） | SSE 订阅端点、发布端点、内存 pub/sub + 频道 ring buffer、保活、Last-Event-ID 短重放、健康端点 | 本期 |
| **共享客户端 + 契约** | `packages/relay-client`（新增 pkg） | 频道/事件类型定义（单一事实源）、Node 发布 helper、Node SSE 订阅 helper（带重连/退避/保活，供 Worker 用） | 本期 |
| **Console 服务端发布** | `apps/console/app/api/**`（在落库调用之后） | 各 mutating route 落库成功后调用发布 helper（best-effort，失败不阻塞用户操作） | 本期 |
| **Console ticket 签发** | `apps/console/app/api/relay/ticket/route.ts`（新增） | 用登录态 + RBAC 算出可订阅频道，签发短时效 ticket | 本期 |
| **Console 浏览器订阅** | `apps/console/app/lib/use-relay.ts`（新增 hook）+ 各 UI 接入 | 用 ticket 连 relay，收到事件直接更新 / 触发 SWR 重校验；relay 不可用回落到现有 `usePolling` | 本期 |
| **Worker 订阅 + 发布** | `apps/worker/src/relay.ts`（新增）+ `runner.ts`/`executor.ts` 接入 | 订阅 `worker:<id>` + 本机关联 `project:<id>`，收到信号立即触发对应 tick；各 DB 写之后发布 | 本期 |
| **DB 轮询双线择优** | Console hook + Worker runner | relay 健康时慢化/暂停轮询、relay 断时恢复轮询节奏；Last-Event-ID gap 用 DB 全量对账自愈 | **TODO（Phase 2）** |

> `packages/relay-client` 与 `packages/db` 一样产出 `dist/`（tsc 构建），Console/Worker runtime 直接 import 编译产物，避免 Next/edge 编译踩 `node:` scheme 坑。事件契约（频道命名、事件 type、负载 DTO）集中在此包，三端（relay/console/worker）共用，避免各写一份漂移。

## 4. 事件模型与频道

### 4.1 频道（Channel）—— RBAC 的最小隔离单位

- `project:<projectId>`：与该项目相关、对「有该项目权限的用户」可见的事件（任务、任务事件、任务评论、对话、对话消息、该项目下 Worker 的在线/工作态变化）。
- `worker:<workerId>`：定向某个 Worker 的事件（新定向指令、新对话轮待认领、取消请求、远程工作态切换、本机可领新任务信号）。

> RBAC 全部在 `project:<id>` 这一层收敛：浏览器 ticket 里列出「该用户可见的 projectId 集合」，relay 只允许订阅 ticket 内的频道，**relay 本身不懂业务 RBAC**。Worker 订阅自身 `worker:<id>` + 本机 `worker_project_links` 对应的 `project:<id>`。

### 4.2 事件信封（全量负载）

```ts
interface RelayEvent {
  id: string;            // relay 生成的单调事件 id（用于 Last-Event-ID 短重放）
  channel: string;       // "project:<id>" | "worker:<id>"
  type: string;          // 见 4.3
  ts: number;            // 发布方时间戳（ms）
  entityId: string;      // taskId / conversationId / commandId / workerId
  projectId?: string;
  seq?: number | string; // 领域排序键：对话用 conversation_messages.seq，任务用 updated_at
  payload: unknown;      // 全量负载（行 DTO），订阅者可直接套用
}
```

订阅者用 `seq`/`ts` 对每个 entity 做**去重 + 排序**（保留 last-applied，丢弃陈旧/重复），消除全量负载模式下的乱序/重发风险。

### 4.3 事件类型（Phase 1 覆盖范围）

| type | 频道 | 发布方 | 负载 |
| --- | --- | --- | --- |
| `conversation.message` | `project:<id>` + `worker:<id>` | Console（用户发）/ Worker（助手轮终态） | 全量 message 行 |
| `conversation.upserted` | `project:<id>` | Console / Worker | 会话头（状态/标题/generating） |
| `task.upserted` | `project:<id>` | Console（建/发布/验收/打回/取消）/ Worker（各状态翻转） | 全量 task 行 |
| `task.comment` | `project:<id>` | Console（回复/打回意见）/ Worker（提问） | 全量 comment 行 |
| `task.event` | `project:<id>` | Worker | task_event 行 |
| `direct_command.upserted` | `project:<id>` + `worker:<id>` | Console（建）/ Worker（状态/结果） | 全量 command 行 |
| `worker.upserted` | `project:<id>` | Worker（注册/心跳/info/工作态） | worker 摘要（在线/工作态/能力） |
| `worker.working_state` | `worker:<id>` | Console（远程切换） | { working_state } |
| `conversation.session.updated` | `project:<id>` | Worker（每次 session 同步，~3s） | 全量 jsonl 文本 |
| `task.session.updated` | `project:<id>` | Worker（每次 session 同步，~20s） | 全量 jsonl 文本 |

**关于 session jsonl**：平台面向小型团队、不涉及大负载，故 session 全文也统一走**全量负载**——Worker 每次同步 session jsonl 后发布 `conversation.session.updated` / `task.session.updated`（带全文），订阅者直接回放，无需再 `GET /api/.../session`。持久化仍落现有 1:1 侧表（`task_sessions` / `conversation_sessions`），relay 只负责把已落库的全文推出去。

## 5. 写路径 / 读路径

### 5.1 写路径（publish-after-commit，本期）

```
用户操作 / Worker 执行
        │
        ▼
 ① 在 DB 事务里落库（权威、持久）   ← 「消息必须落库」在这里满足
        │ 提交成功
        ▼
 ② best-effort 发布全量负载到 relay  ← 失败仅记日志、绝不回滚/不阻塞
        │
        ▼
 relay 扇出给该频道所有订阅者
```

- 发布**必须在 DB 提交成功之后**，保证「能看到推送的，库里一定有」。
- 发布失败（relay down / 网络抖动）不影响主流程：数据已落库，Phase 2 的轮询会把它对账补上；Phase 1 现有轮询天然兜底。

### 5.2 读路径

- **浏览器**：`use-relay` 收到事件 → 直接 patch 本地状态或 `mutate` 触发对应 `/api` 重校验；relay 不可用时回落到现有 `usePolling` 节奏。
- **Worker**：`relay-client` 收到 `worker:<id>` / `project:<id>` 信号 → **立即触发一次对应 tick**（认领指令/对话/任务/取消），而非等 10s；relay 不可用时沿用现有 setInterval 节奏。

## 6. 鉴权

| 主体 | 连接方式 | 鉴权 | 频道授权 |
| --- | --- | --- | --- |
| **浏览器订阅** | `GET /events?ticket=<jwt-ish>` | Console 用 `CLAUDE_CENTER_RELAY_SECRET` 签发短时效 ticket（含 userId + 允许的 projectId 集 + 过期时间）；relay 用同一 secret 验签 | 只能订阅 ticket 内列出的 `project:<id>` |
| **Worker 订阅** | `GET /events` + `Authorization: Bearer <CLAUDE_CENTER_RELAY_WORKER_TOKEN>` | 共享 worker token | 订阅自身 `worker:<id>` + 声明的本机 `project:<id>`（Phase 1 简化：Worker 自报，信任 token；Phase 2 可由 relay 校验 worker_project_links） |
| **发布**（Console 服务端 + Worker） | `POST /publish` + `Authorization: Bearer <CLAUDE_CENTER_RELAY_PUBLISH_TOKEN>` | 共享 publish token | 持 token 即可向任意频道发布（发布方可信，业务上由落库逻辑约束） |

- ticket 短时效（如 60s），浏览器每次（重）连前向 `/api/relay/ticket` 取新 ticket——RBAC 变化（用户被改项目/停用）下一次连接即生效。
- relay 业务无关：只做「token/ticket 是否授予此频道」的判断，不查业务库。
- 全部用对称 secret（与现有 pgcrypto 自包含、无新密钥基础设施的风格一致），无需引第三方鉴权依赖。

## 7. 可靠性（网络波动 / 稳定性 / 自动重连 / 保活 / 断线检测）

| 能力 | 机制 |
| --- | --- |
| **保活（keepalive）** | relay 每 ~15s 向每条连接发 SSE 注释心跳 `:ping`；客户端据此判活。`Content-Type: text/event-stream`，禁用代理缓冲（`X-Accel-Buffering: no`）。 |
| **断线检测** | 客户端记录「上次收到任何字节」的时间戳，超过 ~2.5×ping 间隔无数据 → 判定断开、主动重连；relay 侧记录每连接 last-write，连接异常即清理订阅。 |
| **自动重连** | 浏览器原生 `EventSource` 自带重连；Worker（Node）用 `relay-client` 做**指数退避 + 抖动**（如 1s→2s→…→30s 上限 + 随机抖动），避免雪崩同时重连。 |
| **断点续传** | relay 每频道维护小 **ring buffer**（如最近 200 条 / 60s）；重连带 `Last-Event-ID` 时回放缺口。 |
| **gap 自愈** | 超出 ring buffer 的缺口：客户端**对该频道做一次全量刷新/轮询**（DB 是权威）——这是「消息落库」带来的天然兜底，Phase 2 形式化为 reconnect → DB catch-up。 |
| **背压** | 订阅者消费慢导致积压超阈值时，relay 丢最旧事件并标记该连接「需全量对账」（下次靠 DB 补），不无限缓冲拖垮 relay。 |
| **幂等消费** | 订阅者按 entity 维护 last-applied `seq`/`ts`，重放/重发的陈旧事件直接丢弃。 |
| **优雅退化** | relay 整体不可用：Console 浏览器回落 `usePolling`、Worker 回落 setInterval——功能不降级，仅延迟回到 3–10s。 |

## 8. 双线择优与降级（Phase 2 — TODO）

> 本期（Phase 1）**不实现显式择优**：SSE 与现有轮询**并存**，轮询保持原节奏天然兜底（代价是 relay 在线时仍有冗余轮询）。Phase 2 再做下述「优先 SSE、慢化轮询」的智能切换。

- **健康探测**：客户端基于「SSE 连接是否 open + 近 N 秒有无 ping/事件」维护 `relayHealthy` 状态。
- **SSE 健康时**：把 `usePolling` / Worker tick 间隔**大幅拉长**（如 3s→30s、10s→60s）作为安全网，主要靠推送，显著降 DB 负载。
- **SSE 不健康时**：恢复原轮询节奏，保证功能可用。
- **切换时对账**：每次 SSE（重）连成功后先做一次全量拉取，消除断连期间的缺口。
- 开关：`CLAUDE_CENTER_RELAY_URL` 缺省/置空即整体禁用 relay（纯轮询），便于灰度与回退。

## 9. 配置与环境变量（新增）

| 变量 | 用于 | 说明 |
| --- | --- | --- |
| `CLAUDE_CENTER_RELAY_URL` | Console + Worker | relay 基址（如 `http://127.0.0.1:8787`）；ticket 端点会**透传给浏览器**，必须用浏览器能直连的地址；**留空=禁用 relay、纯轮询** |
| `CLAUDE_CENTER_RELAY_INTERNAL_URL` | Console（可选） | 服务端 publish + `/connections` 代理走内网时单独配（如 docker compose 内 `http://relay:8787` service name）；未配回退 `RELAY_URL`。**只在容器/同机部署省公网回环时用**，本地 dev 无需配。 |
| `CLAUDE_CENTER_RELAY_PORT` | relay | 监听端口（默认 8787） |
| `CLAUDE_CENTER_RELAY_SECRET` | Console + relay | 浏览器 ticket 签发/验签的对称密钥 |
| `CLAUDE_CENTER_RELAY_PUBLISH_TOKEN` | Console + Worker + relay | 发布鉴权 token |
| `CLAUDE_CENTER_RELAY_WORKER_TOKEN` | Worker + relay | Worker 订阅鉴权 token |
| `CLAUDE_CENTER_RELAY_PING_INTERVAL_MS` | relay | 保活心跳间隔（默认 15000） |
| `CLAUDE_CENTER_RELAY_RING_SIZE` | relay | 每频道 ring buffer 容量（默认 200） |

- 沿用现有「仓库根 `.env` 自动加载、shell 优先」机制；新增项进 `.env.example`。
- `.worktreeinclude` 已含 `.env`，worktree 自动带过来；新增 relay 专用密钥也走 `.env`。

## 10. 分期交付

### Phase 1（本期落地）—— SSE 转发 + 消息落库

1. `apps/relay` 服务：`/events`（SSE + ticket/worker token 鉴权 + 保活 + Last-Event-ID + ring）、`/publish`（鉴权 + 扇出）、`/healthz`。
2. `packages/relay-client`：事件契约 + Node 发布 helper + Node SSE 订阅 helper（重连/退避/保活/断线检测）。
3. Console：`/api/relay/ticket` 签发；各 mutating route **落库后** best-effort 发布；`use-relay` hook 接入对话/任务详情/列表等高价值页面（收到事件即 `mutate`）。
4. Worker：`relay.ts` 订阅 `worker:<id>`+`project:<id>`，信号驱动立即 tick；各 DB 写后发布。
5. **不动**现有轮询（继续作隐式兜底）。**消息一律先落库再发布**。

### Phase 2（TODO）—— DB 轮询双线择优降级

1. 客户端 `relayHealthy` 健康态 + SSE 健康时慢化/暂停轮询、断时恢复。
2. reconnect → DB 全量对账（Last-Event-ID 缺口自愈的形式化）。
3. relay 端 worker_project_links 校验 worker 订阅授权（收紧 Phase 1 的自报信任）。
4. 多 relay 实例水平扩展的跨实例广播（见 §12）。

## 11. 验证方案

- **relay 单元/自验脚本**（`apps/relay`）：起 relay → 一个 SSE 订阅者 + 一次 `/publish` → 断言订阅者秒级收到；杀连接 → 断言带 `Last-Event-ID` 重连能补回缺口；ping 保活可见。提供 `--check` 零副作用自检。
- **三包既有验证**：`npm run typecheck`、`npm run build`、`npm run verify:console`（确认接入 relay 后 401→登录→200 不回归；relay 留空时纯轮询路径不受影响）。
- **端到端 demo**：起 relay + console + worker（连一次性干净库），在 Console 发一条对话消息 → 断言 Worker 秒级认领、助手轮回写后 Console 秒级显示（对比关 relay 时的 3–10s）。
- 证据按 `docs/acceptance/sse-relay/` 归档（matrix.csv + round-N.md）。

## 12. 边界与开放问题

1. **大负载（session jsonl）**：平台面向小型团队、不涉及大负载，session jsonl 统一走全量负载（见 §4.3），不做信号+拉取特例。
2. **多 relay 实例水平扩展**：本期 relay 为**单实例内存 pub/sub**（与现有单 Console 进程的内存调度器假设一致）。多实例需跨实例广播背板（Postgres `LISTEN/NOTIFY` 或 Redis pub/sub）——列为 Phase 2+，本期单实例足够。
2. **顺序保证**：全量负载模式下 relay 不保证跨频道全序，仅靠 `seq`/`ts` 在订阅端做每-entity 去重排序；强一致以 DB 为准。
3. **Worker→relay 出网**：受限网络下 Worker 到 relay 的连接可能需代理；沿用 Worker 进程 env 的 `HTTPS_PROXY` 透传（与现有 usage 请求同源问题，需在部署文档提示）。
4. **Electron 渲染进程 vs 主进程**：Worker 的 relay 订阅放主进程（`runner`/`main`），与 DB 访问同侧，避免渲染进程直连。
5. **relay 部署可达性**：relay 需对所有 Console 与 Worker 网络可达；dev 用 localhost，生产部署拓扑写入 `docs/ops/`。

---

## 评审结论（已确认）

| 评审点 | 结论 |
| --- | --- |
| 大负载折中 | 平台面向小型团队、不涉及大负载，session 全文也走全量负载，不做信号+拉取特例（§4.3 已更新） |
| Phase 1 事件范围 | 对话/任务/指令/worker 四域覆盖确认，无增减 |
| 鉴权 | 对称 secret + 短时效 ticket + worker/publish token，确认（不引第三方鉴权基础设施） |
| 端口/命名 | `apps/relay` + 默认端口 8787 确认；env 前缀统一为 `CLAUDE_CENTER_RELAY_*`（即 `CLAUDE_CENTER_RELAY_URL` 等） |

按 Phase 1 在本 worktree 分支（`worktree-sse-relay`）落地实现并自验证。
