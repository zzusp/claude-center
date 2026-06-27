# 已完成任务的续跑机制（PR-B）

> 用户对终态（success / merged）任务的交付不满意时，可发起"继续这个任务"再来一轮 Claude 执行，复用原会话（`--resume`），并区分两种终态走不同的分支/PR 策略。

## 背景

- 现状：`reactivateTask` 把失败/取消任务清空回 draft（推倒重来）；`requestTaskRetry` 让 failed/cancelled 任务带失败原因接着干。
- 缺口：已完成（success / merged）任务无入口。用户对 Claude 交付不满意时只能新建任务从头描述，丢掉原会话上下文，浪费 token + 容易丢细节。
- 关键事实：
  - `tasks.claude_session_id` 已持久化，worker 已支持 `--resume`（`apps/worker/src/executor.ts:203`）。
  - finalize 已能在「`pr_url` 指向的 PR 状态 = MERGED」时清掉旧 url 并新开 PR（`apps/worker/src/executor.ts:1034-1045`）——续跑 case B 直接复用该路径。
  - `listActiveTaskIdsForWorker` 的 GC keep 集合已包含 `success/merged`（`packages/db/src/queries.ts:1094`），续跑前 worktree 仍在。

## 设计

### DB 迁移 `038_task_continuation.sql`

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS continuation_count int NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS continuation_requested_at timestamptz;
```

- `continuation_count`：续跑轮次，每次复活 +1，用于命名 `-cont-N` 分支后缀 / PR body 引用。
- `continuation_requested_at`：Console 打戳，Worker 扫到后清空（同 `retry_requested_at` 设计）。
- 不重建 `tasks_status_check`（复用现有 success/merged/claimed/running 状态机；不引入 `needs_continuation` 之类中间态）。

### API 入口 `apps/console/app/api/tasks/[id]/route.ts`

`PATCH` 新增 `action: "continue"`，body 必含非空 `continuationNote`：

1. 由 `db.continueTask(taskId, note)` 原子完成：
   - `status` → `claimed`（关键！第一步翻 claimed：① 把任务从 `REPLYABLE_TERMINAL_STATUSES` 移出，避免被 `claimNextResumableTask` 误当成普通终态回复走 `resumeTask`；② 仍在 `listActiveTaskIdsForWorker` keep 集合内，worktree 不被并发 GC 误清）。
   - `continuation_count += 1`。
   - `continuation_requested_at = now()`。
   - 清空终态遗留：`finished_at / error_message / merge_status / merge_status_checked_at / merge_checked_at / cancel_requested_at / retry_requested_at / result`。
   - **保留**：`claimed_by`（沿用原 worker）、`claude_session_id`（用于 `--resume`）、`pr_url`（worker 据此判 case A/B）、`work_branch`（case B 时 worker 自行更新为 `-cont-N` 后缀）。
   - 同事务追加 `user` 评论（反馈正文）+ `'continuation_requested'` 事件。
2. 仅 `success / merged` 命中；其它状态返回 409。

### Worker 端 `apps/worker/src/runner.ts` + `executor.ts`

- 新 claim：`claimNextContinuationTask(workerId)` 扫 `status='claimed' AND claimed_by=$1 AND continuation_requested_at IS NOT NULL`，原子翻 `running` + 清 `continuation_requested_at` + 落 `'continuation_started'` 事件。
- 优先级：`resumable > retryable > continuation > pending`（续跑优先级低于失败重试，让失败重试先消费 worker 队列）。
- 新执行函数 `continueExistingTask`：
  - 读 `getPendingContinuationNote(taskId)`：取最近一次 `continuation_requested` 事件之后的所有 user 评论（按时间拼接）。
  - 非 git 项目：直接在 localPath 就地续跑，无分支/PR 处理。
  - git 项目（含多仓）：
    - **per-repo case 判定**：对每个有 `pr_url` 的 ctx 查 `getPrState(prUrl)`。
    - **case A**（OPEN/CLOSED/null/查询失败）：`fresh=false` 复用原 worktree + work_branch；finalize 时复用原 PR（或 `findExistingPrUrl` 找回）。
    - **case B**（MERGED）：新分支 `<原 work_branch>-cont-<N>`，调用 `updateTaskRepoBranchAndResetPr` 同步 DB（work_branch / 清 pr_url / sub_status='pending'），主仓同步 `tasks.work_branch`；删除旧 worktree（best-effort）；`fresh=true` 基于 `origin/<base>` 重建；finalize 走 `gh pr create` 新开 PR。
  - 一律 `--resume claude_session_id`；prompt 首帧拼上反馈：`"用户对前轮结果不满意，反馈如下：\n\n<note>\n\n继续完成 ClaudeCenter 任务。"`，case B 额外提示新分支信息。
  - 后续走 `handleClaudeTurn → finalizeTaskMultiRepo` 现成逻辑收尾，无需修改 finalize。

### Worker GC TOCTOU 二次校验 `apps/worker/src/worktree.ts:gcWorktrees`

现有逻辑：tick 起点 `listActiveTaskIdsForWorker` 拿 keep 集合 → 遍历删除不在 keep 的 worktree。

并发问题：用户刚发起续跑（`success → claimed`），keep 集合是旧快照仍把此 task 视作 success（在 keep 内），但若 race 让 keep 不含此 task（极小窗口）→ worktree 被删 → worker 起手续跑时 ensureWorktree 重建失败。

修复：删除前对每个待删 taskId 调用 `getTaskStatusById` 二次校验；若现状属 `claimed/running/waiting/success/merged/failed/cancelled` 任一种 → 跳过（保留 worktree）；查询失败也跳过（宁可下轮再清，也不冒误清风险）。

### UI `apps/console/app/ui/task-detail.tsx`

- 终态（success / merged）时顶栏额外渲染「继续这个任务」按钮（复用 lucide `PlayCircle` 图标 + `btn btn-primary btn-sm` 样式）。
- 点击弹 `FormModal`（size=md）+ 必填 textarea 收集反馈。
- 提交调 `PATCH /api/tasks/:id` `action='continue' + continuationNote`，成功后 `loadTask()` 刷新（任务即翻 claimed）。
- 时间线新增三种事件标签：`continuation_requested / continuation_started / continuation_branch_rotated`。`continuation_started` 进 `ROUND_START_EVENTS` 和 `EXECUTION_LINK_EVENTS`。

## 不在本期范围

- 续跑反馈的附件支持（沿用 textarea 文本即可，避免 UI 复杂化）。
- 续跑专属的运行时配置（如临时调高 model / 临时换 workflow 开关）——沿用任务原配置。
- 续跑批量入口（列表多选 → 继续）——单条入口够用。
