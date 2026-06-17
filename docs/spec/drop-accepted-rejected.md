# spec: 移除「已验收 / 已打回」状态

## 背景

任务终态历史上有 5 个：success(待验收) / merged(已合并落地) / accepted(人工验收通过) / rejected(打回重跑) /
failed / cancelled。用户反馈状态过多、混乱，要求精简：

1. 去掉「已验收」状态、去掉人工验收步骤、去掉批量验收功能。
2. Worker 接收到任务执行后的终态应只剩三种：**「已完成」(success) / 「失败」(failed) /
   「等待回复」(waiting)**，不再有「已验收」。
3. 定时任务（30s 一次，**仅 Web 端做此检查**）会检查所有「已完成」且有 PR 的任务，如果 PR 已合并则更新
   任务状态为「已合并」(merged)，**不再清理 worktree**。没有 PR 的「已完成」终态就是「已完成」。
4. 任务调度列表支持「提交模式」(submit_mode = pr / push) 的筛选。

## 状态机变化

去掉两个状态：`accepted` / `rejected`。其余生命周期不变。

```
draft → scheduled → pending → claimed → running ↘
                                              ↓ waiting (等用户回复) ↗ resumed
                                              ↓
                                          { success / failed / cancelled }       ← Worker 三个终态
                                              ↓ (仅 success + PR)
                                          Console 30s 轮询: PR 合并? → merged    ← 终态(由 Console 翻)
```

- **success**：Worker 已交付（PR 模式建好 PR / push 模式直推目标分支）。无 PR 时 success 就是最终终态。
- **merged**：Console 检测到 PR 已合并；不清理 worktree，用户可在本地复用。
- 历史 `accepted` → `merged`（视作已落地）。
- 历史 `rejected` → `failed`（带 error_message 说明，用户可走「续接重试 / 激活回草稿」继续推进）。

## 改动清单

### `packages/db`

- `types.ts`：`TaskStatus` 去掉 `accepted` / `rejected`。
- `task-state.ts`：
  - `TASK_STATUSES` 同步更新（全集）。
  - `COMPLETED_STATUSES` 从 `['accepted','merged']` 改为 `['success','merged']`（依赖门控:success 即视作完成）。
- `queries.ts`：
  - 删除 `acceptTask` / `rejectTask` / `claimNextRejectedTask` / `claimNextCleanupCandidate` /
    `setTaskMergeChecked` / `countConsecutiveCleanupRetries` / 旧的 `markTaskMerged`(Worker 终态打 merged)
    / 旧的 `markTaskMergeAccepted`(success→accepted)。
  - 新增 `markTaskMerged`(success→merged,供 Console 检测合并后调用)；语义改为「PR 已合并」翻 merged。
  - `claimNextMergeCheckCandidate` 增加 `pr_url IS NOT NULL` 过滤（用户：「没有 PR 的『已完成』终态就是『已完成』」）。
  - `listActiveTaskIdsForWorker` keep 列表去掉 `rejected`、加上 `merged`（不再清理 worktree）。
  - `listTaskStatsForUser` 今日窗口由 `accepted/rejected` 改为 `completed/failed`。
  - `ListTasksFilters` 增加 `submitMode`(pr/push)；`listTasks` SQL 增加对应 WHERE。
- 新增迁移 `028_drop_accepted_rejected.sql`：
  - `UPDATE` 历史行：accepted → merged、rejected → failed。
  - 重建 `tasks_status_check` CHECK，列出新全集。
  - `COMMENT ON COLUMN tasks.status` 同步新枚举。

### `apps/worker`

- `executor.ts`：
  - 删除 `rerunRejectedTask`、`cleanupMergedTask`、`rejectionPrompt`、`removeAllRepoWorktrees`、`runTolerant`。
  - `finalizeTaskMultiRepo` 中 push 模式从 `markTaskMerged(...)` 改为 `markTaskSuccess(..., null)`（push 终态
    即 success，无 PR；Worker 不再触发 worktree 拆除）。
- `runner.ts`：
  - 移除 `acceptMyTask` / `rejectMyTask` 方法。
  - 认领循环去掉 `claimNextRejectedTask` 与 `claimNextCleanupCandidate` 分支。
  - `ActiveEntry.kind` 去掉 `'cleanup'`。
- `preload.cjs` / `main.ts`：移除 `worker:acceptMyTask` / `worker:rejectMyTask` IPC + 桌面端 UI 按钮；
  `TASK_STATUS_META` 去掉 `accepted/rejected`、success 标签改为「已完成」、分组合并到 "done"。

### `apps/console`

- `instrumentation-node.ts`：合并检查循环改为 30s（用户硬要求），调用 `markTaskMerged`（success→merged）
  替代旧的 `markTaskMergeAccepted`（success→accepted）。
- `app/api/tasks/[id]/review/route.ts`：**删除整个文件**（人工验收 API 入口）。
- `app/api/tasks/bulk/route.ts`：`BulkAction` 去掉 `accept`，runAction 中删除 accept 分支。
- `app/api/tasks/route.ts`：接收 `submitMode` 查询参数（白名单 pr/push），透传给 `listTasks`。
- UI:
  - `tasks.tsx`：状态筛选、批量操作清单同步去掉「验收通过」；新增「提交模式」下拉过滤；今日统计字段
    由 `accepted/rejected` 改 `completed/failed`，完成率 = `completed / finished`。
  - `task-detail.tsx`：去掉 `canReview` 与 lifecycle 的「人工验收」节点。
  - `task-detail-overview.tsx`：删除 `TaskReviewActions` 组件 + 高亮验收行。
  - `task-detail-shared.tsx`：EVENT_META 中 accepted/rejected/merge_accepted/cleanup_retry 标记为
    `[历史]`，保留 label 让历史时间线行能正确回显。
  - `tasks-compose.tsx`：前置任务候选过滤 `accepted` → `success`；提示文案同步。
  - `shared.tsx`：`STATUS_META` 去掉 accepted/rejected；success 标签从「待验收」改为「已完成」；
    `Tone` 类型去掉 `rejected`/`review`。
  - `dashboard-shared.ts`：`TONE_COLOR` 去掉 `rejected` / `review` 键（仍保留 CSS 变量供历史 timeline 使用）。
  - `overview.tsx`：donut 状态列表去掉 accepted/rejected。

### `scripts/smoke-bulk-actions.mts`

- 删除 accept 用例（4/4b/4c），其余 6 个动作（publish/unpublish/cancel/reactivate/retry/delete）保留。

## 历史数据兼容

- task_events 表中历史 `accepted` / `rejected` / `merge_accepted` / `cleanup_retry` 行不删除——
  EVENT_META 仍登记，前缀 `[历史]` 让时间线回放清晰。
- `task_comments` 中的打回意见保留（rejected→failed 不动评论）。
- task_repos.sub_status 不受影响（其枚举无 accepted/rejected）。

## 测试

- `npm run typecheck`：5 个包全绿。
- `npm run build`：5 个包全绿（next build 不再报 missing exports）。
- `node scripts/ephemeral-db.mjs --verify`：临时库跑全量 28 个迁移 + 自动 verify:console，
  返回 401→200 + scheduler.ok=true。
- `node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-bulk-actions.mts`：6 个动作守卫与翻转均通过。
