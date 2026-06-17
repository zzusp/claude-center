# 任务完成后清理 + merged 终态

## 背景与目标

桌面 Worker 的 periodic `tick()`（`apps/worker/src/runner.ts`，默认 10s）覆盖：领 `pending`
任务、续接收到回复的 `waiting` 任务、执行中回写状态。缺最后一环——**任务完成后的清理与终态**。

收尾 `finalizeTask`（`executor.ts`）按 `submit_mode`（见 `task-branch-submit-mode.md`）分流：

- `pr`：push 工作分支 + `gh pr create`，标 `success`。
- `push`：`git push origin work_branch:target_branch` 直推目标分支，标 `success`。

问题：`success` 无法区分「PR 已建待合并」与「已合并落地」；PR 合并后没有机制删工作分支、把本地
切回签出分支；直推已落地的任务也停在 `success`，与「已建未合」混在一起。

本次新增 **`merged` 终态 + PR 合并后清理**（复用既有 `submit_mode`，不引入新的投递模式列）。

## 设计

### merged 终态

- `submit_mode='push'`：直推即落地，`finalizeTask` 收尾时直接 `markTaskMerged`（无 PR、无需轮询）。
- `submit_mode='pr'`：仍先标 `success`（PR 已建待合并）；periodic 轮询检测 PR 合并后清理 → `merged`。
- 无改动：两种模式都标 `success`（无 PR、无落地、无需清理）。

### periodic 清理（仅 pr 模式）

`tick()` 第 4 步（最低优先级，排在领新任务之后；执行类工作优先，清理是 housekeeping）：

1. `claimNextCleanupCandidate(workerId)`：选**本 worker** 的、`status='success'` 且
   `pr_url IS NOT NULL` 的任务，按 `merge_checked_at ASC NULLS FIRST` 轮转取一个（只读，不翻状态）。
   **节流**：`merge_checked_at` 在 60s 内的任务不会再被领取——避免只有一个待清理任务时每 tick（默认
   10s）都重复查 PR / 重试清理；新任务（`NULL`）不受节流，立即进入轮转。
2. `cleanupMergedTask`：在该任务的 `localPath` 下 `gh pr view <pr_url> --json state,mergedAt,url`：
   - `state == 'MERGED'` → 本地清理 → `markTaskMerged`：
     - `git fetch origin --prune`（硬要求；失败抛出，按指数退避重试）
     - `git checkout <base_branch>` + `git merge --ff-only origin/<base_branch>`（**容错**：仅为顺手
       拉新+让 HEAD 离开 work_branch，失败回退 `git checkout --detach origin/<base_branch>`——本地 base
       与远端发散也能离开工作分支，下游 `branch -D` 不被阻挡；同步是 cosmetic 的，下个任务签出时会
       重新 fetch+pull）。历史：`git pull origin <base>` 在并发 fetch 残留多 for-merge 时会报
       「Cannot fast-forward to multiple branches」——显式 ref `merge --ff-only origin/<base>` 决定单一 head。
     - `git branch -D <work_branch>`（容错：squash/rebase 合并时签出分支无该分支提交，必须 `-D`；可能已不存在）
     - `git push origin --delete <work_branch>`（容错：GitHub 可能已自动删除）
   - 其它（`OPEN` / `CLOSED` 未合并）→ `setTaskMergeChecked` 仅打时间戳（不带 backoff），参与下一轮轮转
     （受 60s 节流约束）。
3. `merge_checked_at` 既是轮转游标也是节流游标：每 tick 最多查一个 PR（一次 `gh` 网络调用），
   `NULLS FIRST` 保证新完成的任务优先被查、其余按最久未查轮转；列实际语义是「下次最早可检查时刻」
   ——`setTaskMergeChecked(backoffSeconds)` 把游标推到未来即可延后下一轮领取。

并发安全：`claimNextCleanupCandidate` 只读不加锁；`tick()` 的 `this.polling` 互斥保证同一 worker
不并发 tick；`claimed_by = workerId` 保证只有持有本地工作树的 worker 才清理自己的任务。

清理动作里 `git checkout` / `merge` **容错处理**：失败回退 `git checkout --detach origin/<base>`，确保
HEAD 离开 work_branch 后 `branch -D` 仍能成功；只有 `git fetch` 失败（网络/凭据）才抛出，进入下面的
指数退避重试。`branch -D` / `push --delete` 容错（不抛），删不掉只记录、不挡 `merged` 迁移。

清理整体抛出 → `cleanupMergedTask` 兜底 `setTaskMergeChecked(backoffSeconds)` + 落 `task_events`
（`cleanup_retry`）。`backoffSeconds` 按本次失败前的「连续 cleanup_retry 数」做**指数退避**：
`min(60min, 5min * 2^retries)` → 5/10/20/40/60min，避免长时间网络断 / 凭据失效场景下 5min 一发的
noise event 长期累积。成功落 `merged` 事件后计数自动归零。任务留在 `success` 不丢「已合并」事实。

## 数据库改动（`006_task_cleanup.sql`）

```sql
ALTER TABLE tasks ADD COLUMN merge_checked_at timestamptz;

-- status 增加 'merged'（沿用 003 起的全集 + merged）
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('draft','pending','claimed','running','waiting','success','merged','failed','cancelled'));

-- 清理候选轮转索引
CREATE INDEX tasks_cleanup_idx ON tasks(claimed_by, merge_checked_at)
  WHERE status = 'success' AND pr_url IS NOT NULL;

-- 早期版本的 delivery_mode 已统一到 submit_mode，存量库清掉（全新库 no-op）
ALTER TABLE tasks DROP COLUMN IF EXISTS delivery_mode;
```

> 历史：本特性早期曾引入独立的 `delivery_mode`（pr/direct）列与 `003_task_cleanup.sql`；rebase 到
> main 后发现 `004_task_target_branch.sql` 的 `submit_mode`（pr/push）已覆盖直推，遂弃用 `delivery_mode`、
> 迁移改名 `006`，只保留 merged 终态与清理。多 worktree 共用一个远程 dev 库，迁移取未占用编号、
> CHECK 列取全集（见记忆 claude-center-parallel-migrations）。

## 影响面

- `packages/db/migrations/006_task_cleanup.sql`：新增迁移。
- `packages/db/src/types.ts`：`TaskStatus` 加 `merged`；`Task` 加 `merge_checked_at`。
- `packages/db/src/queries.ts`：新增 `markTaskMerged`、`claimNextCleanupCandidate`、`setTaskMergeChecked`。
- `apps/worker/src/executor.ts`：`finalizeTask` 的 `push` 分支改标 `merged`；新增 `cleanupMergedTask`。
- `apps/worker/src/runner.ts`：`tick()` 加第 4 步清理。
- `apps/console/app/ui/dashboard.tsx` / `globals.css`：`STATUS_META`/`TONE_COLOR`/状态筛选/donut/时间线/事件标签 + `merged` 色板。
- `README.md` / `docs/spec/claude-center-mvp.md`：补 merged 终态与清理说明。

## 验证

- `npm run typecheck`、`npm -w @claude-center/console run build`（worktree 验证按
  [[worktree-console-verify]] 1→2→3 准备）。
- 迁移与查询函数用事务内 round-trip 验证（共享 dev 库，结束 ROLLBACK 不污染其它在飞分支的约束/数据）。
