# 任务发布门禁：草稿态 + 关联项目认领约束

## 需求

1. **新建任务不能直接被领取**：任务新建后应处于「草稿 / 待发布」状态，需要人工切换状态（发布）后，Worker 才能认领。
2. **Worker 只能认领本地已关联项目的任务**：Worker 没有关联某项目（`worker_project_links`）时，无法认领该项目下的任务。

## 现状（开工前）

- `tasks.status` 生命周期：`pending → claimed → running → (waiting) → success/failed/cancelled`，新建任务默认 `pending`（`001_init.sql:53`）。
- `claimNextTask`（`packages/db/src/queries.ts`）认领条件为 `status = 'pending'`，**新建即可被领**——不满足需求 1。
- 需求 2 **已实现**：`claimNextTask` 已 `JOIN worker_project_links ON project_id = tasks.project_id` 并过滤 `worker_id = $1 AND enabled = true`；`getTaskLocalPath` 在执行阶段用同一 JOIN 兜底。项目无任何 Worker 关联时，任务永远停在队列无人领。本次不改这条，仅复核保留。

## 方案

在 `pending` 之前新增初始态 `draft`，不改动 `pending` 的「已入队、可认领」语义，因此 `claimNextTask` / overview 统计 / 现有状态标签全部无需变动，认领门禁自动生效。

任务状态生命周期变为：

```
draft ──发布──▶ pending ──认领──▶ claimed ──▶ running ──▶ (waiting) ──▶ success/failed/cancelled
```

- **新建**：`createTask` 不指定 status，依赖列默认值；迁移 `003` 将默认值从 `pending` 改为 `draft`，故新任务落 `draft`。
- **发布（状态切换）**：Console 在任务详情对草稿任务提供「发布」按钮 → `PATCH /api/tasks/:id { action: "publish" }` → `publishTask` 执行 `UPDATE ... SET status='pending' WHERE id=$1 AND status='draft'`。`WHERE status='draft'` 保证只有草稿可发布，对已认领 / 运行中 / 已完成任务幂等无副作用。
- **认领**：`claimNextTask` 仍只捞 `status='pending'`，草稿不进候选——门禁生效。

## 改动清单

- `packages/db/migrations/003_task_draft_status.sql`：放开 `tasks_status_check` 增加 `draft`；`ALTER COLUMN status SET DEFAULT 'draft'`。
- `packages/db/src/types.ts`：`TaskStatus` 增加 `"draft"`。
- `packages/db/src/queries.ts`：新增 `publishTask(client, taskId)`。
- `apps/console/app/api/tasks/[id]/route.ts`（新建）：`PATCH` 发布草稿。
- `apps/console/app/ui/dashboard.tsx`：`STATUS_META` 增加 `draft`（「草稿」）；任务详情头部对草稿任务渲染「发布」按钮；状态分布环图纳入 `draft`；新建成功提示改为「任务已创建为草稿」。
- `apps/console/app/globals.css`：新增 `--draft` 颜色与 `.badge` / `.dot` 的 `data-tone="draft"` 规则。
- 文档：`README.md`、`docs/spec/claude-center-mvp.md` 同步生命周期。

## 验证

- `npm run typecheck` / `npm run build` 通过。
- `npm run db:migrate` 应用 `003`。
- 端到端：新建任务 → 列表显示「草稿」、Worker 不领取 → 点「发布」转「待处理」→ Worker 认领（仅当本机关联了该项目）。
