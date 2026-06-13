# 任务完成后清理 + 直推模式 + merged 终态

## 背景与目标

桌面 Worker 的 periodic `tick()`（`apps/worker/src/runner.ts`，默认 10s）此前覆盖三件事：领取
`pending` 任务、续接收到回复的 `waiting` 任务、执行中回写状态。缺第四件——**任务完成后的清理**。

现状的终点是 `finalizeTask`（`executor.ts`）：commit → push work 分支 → `gh pr create` → 标
`success`，然后就停了。问题：

- `success` 只代表「PR 已创建」，无法区分「PR 已合并落地」。看板上两者都显示「已完成」。
- PR 合并后没有任何机制删本地/远端 work 分支、把本地仓库切回 base、更新本地 base。work 分支
  无限堆积，本地仓库停在一堆陈旧 work 分支上。
- 没有「不开 PR、直接把改动推到目标分支」的投递方式。

本次新增两条能力（已与用户确认）：

1. **`merged` 终态**：区别于 `success`（PR 已建未合）。PR 合并并完成本地清理后、或直推已落地后，
   任务进入 `merged`。
2. **直推模式 `delivery_mode = 'direct'`**：任务不开 PR，Worker 直接在 base 分支上 commit 并
   `push` 到 base，推送成功即 `merged`。默认仍是 `delivery_mode = 'pr'`。

## 投递模式（delivery_mode）

任务级字段，建任务时设定，默认 `'pr'`。

| 模式 | 工作分支 | 收尾 | 终态 |
|------|---------|------|------|
| `pr`（默认） | 从 base 建 `work_branch` | commit → push work → `gh pr create` → `success`；待 periodic 检测 PR 合并后清理 → `merged` | `success` → `merged` |
| `direct` | 直接在 base 上工作（不建 work 分支） | commit → `push origin HEAD:base` → `merged`（已落地，无 PR、无需清理分支） | `merged` |

两种模式 Claude 无改动时都标 `success`（无 PR、无落地、无需清理）。

## periodic 清理（PR 模式）

`tick()` 新增第 4 步（最低优先级，排在领新任务之后；执行类工作优先，清理是 housekeeping）：

1. `claimNextCleanupCandidate(workerId)`：选**本 worker** 的、`status='success'` 且
   `pr_url IS NOT NULL` 的任务，按 `merge_checked_at ASC NULLS FIRST` 轮转取一个（只读，不翻状态）。
2. `cleanupMergedTask`：在该任务的 `localPath` 下 `gh pr view <pr_url> --json state,mergedAt,url`：
   - `state == 'MERGED'` → 本地清理 → `markTaskMerged`：
     - `git fetch origin --prune`
     - `git checkout <base>` + `git pull --ff-only origin <base>`（拉进已合并的改动）
     - `git branch -D <work_branch>`（容错：可能已不存在；用 squash/rebase 合并时 base 没有该
       分支的提交，必须 `-D`）
     - `git push origin --delete <work_branch>`（容错：GitHub 可能已自动删除）
   - 其它（`OPEN` / `CLOSED` 未合并）→ `setTaskMergeChecked` 仅打时间戳，参与下一轮轮转。
     本版只对 `MERGED` 做状态迁移；`CLOSED` 未合并不自动改状态（留给用户判断），但仍定期复查。
3. `merge_checked_at` 既是轮转游标也是节流：每 tick 最多查一个 PR（一次 `gh` 网络调用），
   `NULLS FIRST` 保证新完成的任务优先被查、其余按最久未查轮转。

并发安全：`claimNextCleanupCandidate` 只读不加锁。`tick()` 的 `this.polling` 互斥保证同一 worker
不并发 tick；`claimed_by = workerId` 保证只有持有本地工作树的 worker 才清理自己的任务，跨 worker
不会撞。故无需 `FOR UPDATE`。

清理动作里 `git checkout` / `pull` 失败 → 抛出 → `cleanupMergedTask` 兜底 `setTaskMergeChecked` +
落 `task_events`，任务留在 `success` 等下一轮重试（不丢「已合并」事实，下轮继续清）。`branch -D` /
`push --delete` 容错（不抛），删不掉只记录、不挡 `merged` 迁移。

## 数据库改动（`003_task_cleanup.sql`）

```sql
ALTER TABLE tasks ADD COLUMN delivery_mode text NOT NULL DEFAULT 'pr'
  CHECK (delivery_mode IN ('pr', 'direct'));
ALTER TABLE tasks ADD COLUMN merge_checked_at timestamptz;

-- status 增加 'merged'
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending','claimed','running','waiting','success','merged','failed','cancelled'));

-- 清理候选轮转索引
CREATE INDEX tasks_cleanup_idx ON tasks(claimed_by, merge_checked_at)
  WHERE status = 'success' AND pr_url IS NOT NULL;
```

## 影响面

- `packages/db/migrations/003_task_cleanup.sql`：新增迁移。
- `packages/db/src/types.ts`：`TaskStatus` 加 `merged`；`Task` 加 `delivery_mode`、`merge_checked_at`；新增 `DeliveryMode`。
- `packages/db/src/queries.ts`：`createTask` 收 `deliveryMode`；新增 `claimNextCleanupCandidate`、`setTaskMergeChecked`、`markTaskMerged`。
- `apps/worker/src/executor.ts`：`executeTask` / `finalizeTask` 按 `delivery_mode` 分叉；新增 `cleanupMergedTask`。
- `apps/worker/src/runner.ts`：`tick()` 加第 4 步清理。
- `apps/console/app/api/tasks/route.ts`：收 `deliveryMode`。
- `apps/console/app/ui/dashboard.tsx`：发布表单加投递模式选择；`STATUS_META`/donut 加 `merged`。
- `apps/console/app/globals.css`：`merged` 色板与 `data-tone`。
- `README.md` / `docs/spec/claude-center-mvp.md`：补状态机与投递模式说明。

## 验证

- `npm run typecheck`、`npm -w @claude-center/console run build`（worktree 验证按
  [[worktree-console-verify]] 1→2→3 准备）。
- `npm run db:migrate` 应用 003（向已有库加列/约束/索引，幂等用 `IF NOT EXISTS` / `DROP ... IF EXISTS`）。
