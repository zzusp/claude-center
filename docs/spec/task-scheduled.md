# 定时任务：到点自动进入待处理队列

## 需求

Web Console 新建任务时可以指定一个「发布时间」；到达该时间后，任务自动从初始态转为「待处理」（`pending`），进入可认领队列，供在线 Worker 领取。无需人工到点手动点「发布」。

## 现状（开工前）

- 任务初始态是 `draft`（草稿，`003_task_draft_status.sql`）：Worker 不认领，需人工在详情点「发布」→ `PATCH /api/tasks/:id { action: "publish" }` → `publishTask` 执行 `UPDATE ... SET status='pending' WHERE id=$1 AND status='draft'`（`packages/db/src/queries.ts:96`）。
- `claimNextTask` 只捞 `status='pending'`（`queries.ts:320`）。
- 状态生命周期：`draft → pending → claimed → running →（waiting）→ success/(merged|accepted|rejected)/failed/cancelled`。
- 无任何「定时 / 延迟发布」能力——只能即时手动发布。
- Console 是长驻 Node 服务（`next dev` / `next start`，`scripts/dev-console.mjs` 启动前已把根 `.env` 注入 `process.env`，故服务进程内 `getPool()` 可直连数据库）。

## 方案

新增一个与 `draft` 平行的初始态 `scheduled`（定时待发），配一个 `tasks.scheduled_at` 时间列。建任务时若指定了发布时间，任务落 `scheduled` + `scheduled_at=T`；到点后由 **Console 内的后台调度器** 把它翻成 `pending`。

生命周期新增一条入口分支：

```
draft     ──人工发布──────────────▶ pending ──▶ claimed ──▶ ...
scheduled ──到点(自动) / 人工立即发布──▶ pending ──▶ claimed ──▶ ...
```

### 提升时机放在哪 —— 选 Console 后台调度器（候选三选一）

| 候选 | 做法 | 取舍 |
| --- | --- | --- |
| **A. Console 后台调度器（采用）** | `apps/console/instrumentation.ts` 在服务启动时 `setInterval` 周期跑 `promoteDueScheduledTasks`（全局 `UPDATE ... WHERE status='scheduled' AND scheduled_at<=now()`） | 「定时」机制落在「web 端」，正合需求措辞；Worker **零改动**、风险最小；状态翻转不依赖 Worker 是否在线，Console 看板始终如实显示。代价：依赖 Console 进程在跑——但这本就是 web 特性的前提，且 Console 是本产品的中枢、默认常驻 |
| B. Worker tick 提升 | Worker 每个 poll tick 顶部调 `promoteDueScheduledTasks` | 复用现有轮询，但要改 Worker；且无 Worker 在线时状态不翻转，看板显示滞后 |
| C. 折进 `claimNextTask` | 认领时顺带把到点 scheduled 视为可领 | 不产生显式 `pending` 状态、看板看不到「待处理」，违背「自动更新状态为待处理」的字面需求 |

采用 A。一条清晰路径：提升只发生在 Console 调度器里，`UPDATE` 幂等（`WHERE status='scheduled'`），多 worker / dev HMR 重复触发也无害。

### 关键设计点

- **`scheduled` 与 `draft` 互斥的两种初始态**：建任务时 `scheduledAt` 为空 → 老路径落 `draft`（仍需人工发布）；非空 → 落 `scheduled`。语义清晰、互不污染。
- **`publishTask` 放开到 `scheduled`**：把 WHERE 改为 `status IN ('draft','scheduled')`，于是详情页「发布」按钮对定时任务即「立即发布」（在到点前手动提前发布，覆盖定时）。复用同一端点，不新增动作。
- **`scheduled_at` 校验**：API 侧要求可解析且为将来时间（`<= now()` 返回 400），避免「定时到过去」的歧义。
- **审计事件**：提升时为每个任务写一条 `task_events`（`event_type='scheduled_published'`），与现有每次状态流转都落事件的约定一致，时间线可见。
- **类型无关**：工作类 / 问答类都可定时（两者都走 `draft→pending` 被认领的入队语义）。

## 改动清单

- `packages/db/migrations/009_task_scheduled.sql`（新建）：
  - `ALTER TABLE tasks ADD COLUMN scheduled_at timestamptz;`
  - 重建 `tasks_status_check`，**列出当前全部合法状态全集 + `scheduled`**（沿用本项目「每次重建列全集」约定，避免覆盖并行迁移引入的状态）。
  - 部分索引 `tasks_scheduled_idx ON tasks(scheduled_at) WHERE status='scheduled'`，供调度器高效捞到点任务。
- `packages/db/src/types.ts`：`TaskStatus` += `"scheduled"`；`DirectCommandStatus` 排除 `scheduled`（定向指挥无此态）；`Task` += `scheduled_at: string | null`。
- `packages/db/src/queries.ts`：
  - `createTask` 入参 += `scheduledAt?: string | null`；INSERT 显式写 `status`（`scheduledAt ? 'scheduled' : 'draft'`）+ `scheduled_at`。
  - `publishTask` WHERE 放开为 `status IN ('draft','scheduled')`。
  - 新增 `promoteDueScheduledTasks(client): Promise<number>`：`UPDATE ... RETURNING id`，逐条写 `scheduled_published` 事件，返回提升条数。
- `apps/console/instrumentation.ts`（新建）：`register()` 仅在 `NEXT_RUNTIME==='nodejs'` 时启动 `setInterval`（默认 30s，可经 `CLAUDE_CENTER_SCHEDULER_INTERVAL_MS` 覆盖），周期调 `promoteDueScheduledTasks`，提升 >0 时打日志；用 `globalThis` 标志位防 dev HMR 重复起定时器。
- `apps/console/app/api/tasks/route.ts`：`POST` 读 `scheduledAt`，校验可解析且为将来时间，透传给 `createTask`；GET 状态白名单 += `scheduled`。
- `apps/console/app/ui/dashboard.tsx`：`Tone` += `"scheduled"`；`STATUS_META` / `TONE_COLOR` / 状态分布环图 / `STATUS_FILTERS` 纳入 `scheduled`；建任务表单加「定时发布」`datetime-local` 字段；提交时透传 `scheduledAt`、成功提示按是否定时分叉；详情头部「发布」按钮放开到 `scheduled`（文案「立即发布」）；详情概览加「定时发布」时间行；`EVENT_LABEL` += `scheduled_published`。
- `apps/console/app/globals.css`：新增 `--scheduled` 颜色 + `.badge`/`.dot` 的 `data-tone="scheduled"` 规则。
- `README.md`：新增「定时任务」一节，同步生命周期与迁移 009。

## 验证

- `npm run typecheck` / `npm run build` 通过。
- `npm run db:migrate` 应用 `009`。
- 端到端（脚本 `docs/acceptance/task-scheduled/scripts/`）：
  1. 建定时任务（`scheduledAt` = 几秒后）→ 状态 `scheduled`、Worker / `claimNextTask` 不认领。
  2. 到点后调度器把状态翻为 `pending`、并落 `scheduled_published` 事件。
  3. `scheduledAt` 为过去时间 → API 返回 400。
  4. `scheduled` 任务点「立即发布」→ 直接 `pending`（覆盖定时）。
