# 验收报告：移除「已验收 / 已打回」状态

> 日期：2026-06-17
> 分支：cc/task-1781674647198
> 状态：✅ 全绿（见 [matrix.csv](./matrix.csv) 与 [round-1.md](./round-1.md)）

## 用户需求映射

| 用户要求 | 落点 | 验证证据 |
|---|---|---|
| 1. 去掉「已验收」状态、人工验收步骤、批量验收功能 | 删 `TaskStatus.accepted/rejected`、删 `acceptTask`/`rejectTask`、删 `/api/tasks/[id]/review`、bulk 端点去掉 `accept` 动作、UI 去掉「验收通过/打回」按钮 | round-1.md §2/§5；smoke 6 动作通过、`accept` 用例删除 |
| 2. Worker 终态只剩 success/failed/waiting | `apps/worker/src/executor.ts` 的 finalize 路径只用这三种；push 模式从 `markTaskMerged` 改为 `markTaskSuccess`；`cleanupMergedTask`/`rerunRejectedTask` 删除；桌面端 `acceptMyTask`/`rejectMyTask` 删除 | round-1.md §5/§7 |
| 3. 定时任务 30s 一次，仅 Web 端，success+PR → 已合并 → 翻 merged，不清理 worktree | `apps/console/instrumentation-node.ts` 合并循环间隔 30s，调用新 `markTaskMerged`（success→merged）；`claimNextMergeCheckCandidate` 加 `pr_url IS NOT NULL` 过滤；Worker 不再有 cleanup 路径 | round-1.md §3（intervalMs=30000）、§7 |
| 4. 任务调度列表支持「提交模式」筛选 | `ListTasksFilters.submitMode` + `listTasks` WHERE；`/api/tasks` 接收 `submitMode` 查询参；`tasks.tsx` 工具栏新增「全部模式 / 创建 PR / 直接推送」下拉 | round-1.md §1/§2 通过 typecheck + build |

## 关键代码定位

- 状态机：`packages/db/src/types.ts:1-13`、`packages/db/src/task-state.ts:8-32`
- 迁移：`packages/db/migrations/028_drop_accepted_rejected.sql`
- 新合并检查：`packages/db/src/queries.ts::claimNextMergeCheckCandidate` / `markTaskMerged`
- Console 定时：`apps/console/instrumentation-node.ts:11-117`
- Worker 终态：`apps/worker/src/executor.ts` 的 `finalizeTaskMultiRepo`、`apps/worker/src/runner.ts::claimAndStartOne`
- 提交模式筛选：`packages/db/src/queries.ts::ListTasksFilters` / `listTasks`；`apps/console/app/api/tasks/route.ts`；`apps/console/app/ui/tasks.tsx::SUBMIT_MODE_FILTERS`

## 历史数据兼容

- `tasks` 表中历史 `accepted` 行经迁移 028 自动映射为 `merged`，`rejected` 行映射为 `failed`（带说明
  error_message）。
- `task_events` 中历史 `accepted` / `rejected` / `merge_accepted` / `cleanup_retry` 行保留，UI
  `EVENT_META` 给它们带 `[历史]` 前缀（`apps/console/app/ui/task-detail-shared.tsx`）。
- 打回意见评论原样保留在 `task_comments` 中。

## 已确认无回归点

- typecheck/build：5 包 0 error。
- migration on ephemeral db + verify:console：401→200 + scheduler.ok=true（间隔 30000ms）。
- smoke-bulk-actions：剩余 6 动作 + 2 守卫全过。

## 后续 (out of scope)

- 旧 spec 文档（`task-acceptance-dependencies.md` / `task-merge-status-check.md` /
  `task-cleanup-merge.md` 等）仍描述老人工验收 / Worker 清理流程；后续如需可标记 deprecated，
  本次 PR 不动它们以免无关 diff 膨胀。
