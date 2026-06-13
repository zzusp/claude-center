# 人工验收 + 任务前置依赖门控

## 需求

1. 任务执行完成（原 `success`）后不是终态，仍需用户**人工验收**：验收通过 → 终态 `accepted`；验收不通过 → **打回**让 Worker 带着打回意见**续接重跑**。
2. 任务间存在**前置/后置**依赖（仅限同项目）。某任务的任一前置未达 `accepted` 时，Worker **不能领取**该任务。

## 现状（已读源码确认）

- 状态机 `tasks.status`：`pending→claimed→running→(waiting⇄running)→success/failed/cancelled`（`migrations/001_init.sql:53`、`002_task_comments.sql:9`）。`success` 为终态。
- 领取门控集中在 `queries.ts:claimNextTask`（同项目 + `pending` + 工作树互斥），续接在 `claimNextResumableTask`（`status='waiting'` 且有比最后一条 worker 评论更新的 user 评论）。
- Worker `executor.ts`：`executeTask` 建分支后跑首轮；`resumeTask` **不重建分支**续接同一 Claude 会话；`finalizeTask` 每次都 `gh pr create`。`shell.ts:80` 对**非零退出码 reject**。
- Console `dashboard.tsx`：`STATUS_META` 状态色板 + 任务详情 tab（概览/对话/时间线/日志）+ 对话区在 `waiting` 时可回复。

## 关键约束（决定了打回不能照搬 resume）

- `success` 之后改动已 commit/push、工作树可能已被同项目其他任务 `checkout -B` 切走分支。所以**打回重跑必须先 `git checkout work_branch` 再续接**，不能用 `resumeTask`（它刻意不 checkout 以保留未提交改动）。
- 打回重跑时 PR 已存在，`finalizeTask` 再 `gh pr create` 会非零退出→任务被误标 `failed`。故 `finalizeTask` 在 `task.pr_url` 已存在时**跳过建 PR**（push 自动更新已存 PR），正常首轮路径不受影响（首轮 `pr_url` 为 null）。

## 方案

### 状态机

新增两态：`accepted`（人工验收通过，终态）、`rejected`（打回，等待 Worker 重跑）。

```
pending → claimed → running → (waiting⇄running) → success ─┬─ accepted(终)
                                                          └─ rejected → running(重跑) → success → …(可再验收)
failed / cancelled 仍为终态
```

`success` 语义变为「执行完成·待验收」。

### 数据模型（migration `004_task_acceptance_dependencies.sql`）

> 编号 004 而非 003：并行分支 `worktree-task-cleanup-merge` 已占用 `003_task_cleanup.sql`（新增 `'merged'` 终态，同样重建 `tasks_status_check`）。本迁移排在其后应用，约束需列全集（base + `waiting` + `merged` + `accepted` + `rejected`），否则后跑者会把对方的状态覆盖掉。两分支合并到 main 时需保证本迁移仍是最高编号、约束为全集。

- `tasks.status` CHECK 增加 `'accepted'`、`'rejected'`（约束重建时携带全集，含并行分支的 `'merged'`）。
- 新表 `task_dependencies(task_id FK, depends_on_task_id FK, created_at)`，主键 `(task_id, depends_on_task_id)`，`CHECK(task_id<>depends_on_task_id)`，索引 `(depends_on_task_id)`。多对多，`ON DELETE CASCADE`。
- 同项目约束在应用层 `addTaskDependencies` 校验（前置须与本任务同 `project_id`），不加触发器（MVP 不过度设计）。

### 领取门控（`claimNextTask`）

候选 WHERE 增加：本任务不存在「状态非 `accepted` 的前置」。

```sql
AND NOT EXISTS (
  SELECT 1 FROM task_dependencies dep
    JOIN tasks pre ON pre.id = dep.depends_on_task_id
   WHERE dep.task_id = tasks.id AND pre.status <> 'accepted'
)
```

边界：前置若 `cancelled`/`failed`/`rejected` 则后置永久阻塞，直到前置最终 `accepted`（符合需求「仅验收解除」）。

### 验收 / 打回（Console → DB）

- 查询 `acceptTask(client,id)`：`UPDATE … status='accepted' WHERE id=$1 AND status='success' RETURNING *` + `task_event`。
- 查询 `rejectTask(client,id,feedback)`：校验 `status='success'` → 加 user 评论(打回意见) → 翻 `rejected` + `task_event`。**在同一事务内**完成，避免 Worker 在「已翻 rejected 但评论未落」窗口领走导致空跑。
- API `POST /api/tasks/[id]/review` `{action:'accept'|'reject', feedback?}`；事务包裹；非 `success` 返回 409。

### Worker 重跑（`executor.ts` + `runner.ts` + `queries.ts`）

- 查询 `claimNextRejectedTask(workerId)`：`status='rejected' AND claimed_by=me` 原子翻 `running`（`claimed_by` 在首轮已锁定同机，保证同工作树 + 同机 Claude 会话磁盘）。
- `runner.tick` 顺序：定向指令 → 续接(waiting) → **打回重跑(rejected)** → 领新任务。
- `rerunRejectedTask`：`git fetch` → `git checkout work_branch`（改动已提交，恢复分支）→ `runClaudeJson(rejectionPrompt(feedback), resume=claude_session_id)` → `handleClaudeTurn`。
- `finalizeTask`：`task.pr_url` 已存在则跳过 `gh pr create`，复用原 `pr_url`（push 已更新该 PR）。

### Console UI（`dashboard.tsx` + `globals.css`）

- 色板：新增 tone `review`（待验收，`--review:#ea580c`）、`rejected`（已打回，`--rejected:#db2777`）；`accepted` 复用 `success` 绿。`STATUS_META`：`success`→「待验收」(review)、`accepted`→「已验收」(success)、`rejected`→「已打回」(rejected)。
- 发布任务表单：新增「前置任务（同项目，多选）」`<select multiple name="dependsOn">`，候选为所选项目下未取消的任务。
- 任务详情：概览展示「前置任务」（标题 + 状态，由 overview.tasks 解析）与「阻塞中」提示（`status='pending' && blocked`）；`status='success'` 时显示「验收通过 / 打回」操作（打回需填意见）。时间线增「人工验收」节点。
- `listRecentTasks` 增列 `depends_on uuid[]`、`blocked bool`（LEFT JOIN LATERAL 聚合前置及「存在非 accepted 前置」）。

## 验证

- 静态（本会话）：`npm run typecheck`、`npm run build`、`npm run verify:console`（需 `.env` 的 `DATABASE_URL` 可达）。
- 端到端（用户机器，需 Postgres + claude + gh）：
  1. `npm run db:migrate` 应用 004。
  2. 建任务 A、任务 B（B 前置选 A）。确认 B 在 A 未 `accepted` 前不被领取（保持 pending·阻塞中）。
  3. A 跑完进入「待验收」。打回并填意见 → Worker 重跑、更新同一 PR → 再次「待验收」。
  4. A 验收通过(`accepted`) → B 解除阻塞、可被领取。

## 边界

- 依赖仅同项目；打回重跑依赖同机同目录 + Claude 会话磁盘持久化（`claimed_by` 已锁定同机），Worker 离线则重跑/续接挂起。
- 不引入 WebSocket，沿用 3s 短轮询。
- `cancelled`/`failed`/`rejected` 前置不会自动解除后置阻塞。
