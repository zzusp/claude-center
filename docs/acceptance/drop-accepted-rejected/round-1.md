# round-1 验证记录

> 日期：2026-06-17
> 分支：cc/task-1781674647198

## 1. `npm run typecheck`（5 包全绿）

```
> @claude-center/db@0.1.0 typecheck
> @claude-center/relay-client@0.1.0 typecheck
> @claude-center/console@0.1.0 typecheck
> @claude-center/worker@0.1.0 typecheck
> @claude-center/relay@0.1.0 typecheck
```

无任何 TS error。

## 2. `npm run build`（5 包全绿，含 next build）

```
+ First Load JS shared by all             103 kB
  ├ chunks/18-a6801e2fc629b9f0.js        46.3 kB
  ├ chunks/87c73c54-24122e7b92478d00.js  54.2 kB
> @claude-center/worker@0.1.0 build → 通过
> @claude-center/relay@0.1.0 build → 通过
```

`/tasks` 9.4 kB / `/tasks/[id]` 168 kB — Console 路由全部正常编译。

## 3. 迁移落库 + `verify:console` 联跑

命令：`node scripts/ephemeral-db.mjs --verify`

```
✓ created claude_center_ephemeral_1781676443228
✓ applied 28 migrations (最末一条 = 028_drop_accepted_rejected.sql)
{
  "unauthDashboardStatus": 401,
  "loginStatus": 200,
  "pageStatus": 200,
  "health": {
    "db": {"ok": true, "latencyMs": 162, ...},
    "scheduler": {
      "startedAt": "2026-06-17T06:07:59.939Z",
      "intervalMs": 30000,
      "lastTickAt": "2026-06-17T06:08:00.178Z",
      "lastError": null,
      "tickCount": 1,
      "ok": true
    }
  }
}
✓ verify:console 通过
✓ dropped database claude_center_ephemeral_1781676443228
```

证据：401 → 登录 200 → 受保护页 200；`scheduler.ok=true` 证明 `instrumentation-node.ts` 中
依赖的 `markTaskMerged` / `claimNextMergeCheckCandidate` / `setTaskMergeUnmerged` 在运行时
都能正常加载（旧的 `markTaskMergeAccepted` 已替换）。`intervalMs=30000` 反映新的 30s 合并检查
周期已生效。

## 4. 批量操作冒烟（剩余 6 个动作 + 守卫）

命令：`node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-bulk-actions.mts`

```
✓ created claude_center_smoke_1781676514560
✓ migrations applied
>> tsx scripts/smoke-bulk-actions.mts
✓ publish: draft → pending
✓ unpublish: pending → draft
✓ cancel: claimed → cancel_requested_at 已落
✓ reactivate: failed → draft（现场已清）
✓ retry: cancelled → retry_requested_at 已落
✓ delete: draft / failed 均删除成功
✓ guard: delete(running) 被拒绝
✓ guard: publish(success) 被拒绝

all bulk action helpers verified
✓ dropped claude_center_smoke_1781676514560
```

`accept` 用例已删除；其余 6 个动作 + 守卫均通过。

## 5. 残留引用 grep（生产源码层）

```powershell
# .ts / .tsx / .mts / .cjs / .mjs 内不应再出现已删除符号
grep -r 'acceptTask|rejectTask|claimNextRejectedTask|claimNextCleanupCandidate|\
markTaskMergeAccepted|cleanupMergedTask|rerunRejectedTask|countConsecutiveCleanupRetries|\
acceptMyTask|rejectMyTask' --include='*.ts' --include='*.tsx' --include='*.mts' \
  --include='*.cjs' --include='*.mjs' apps/ packages/ scripts/
```

结果：**0 命中**。仅 docs/spec/ 旧设计文档与 README 中保留历史描述（非可执行）。

## 6. 状态机校验

- `packages/db/src/types.ts::TaskStatus` 与 `task-state.ts::TASK_STATUSES` 一致，仅 10 个状态
  （去掉 accepted/rejected）。`satisfies readonly TaskStatus[]` 保证 TS 编译期对齐。
- `028_drop_accepted_rejected.sql` 在干净库上跑：
  - 先 UPDATE 历史行 accepted → merged、rejected → failed（带 error_message）。
  - 重建 `tasks_status_check` CHECK，列出新全集 10 个状态。
  - `COMMENT ON COLUMN tasks.status` 同步新枚举。
  - 经 `--verify` 通过：意味着既不撞 CHECK 约束也不违反外键/索引。

## 7. Worker 清理路径移除

- `apps/worker/src/runner.ts::claimAndStartOne`：仅 4 个分支（direct_command / resume / retry /
  claim_next），不再有 `cleanup` / `rejected` 分支。
- `ActiveEntry.kind` 类型缩窄为 `"task" | "command"`。
- `cleanupMergedTask` / `rerunRejectedTask` 函数在 `apps/worker/src/executor.ts` 中已不存在；
  关联辅助 `runTolerant` / `removeAllRepoWorktrees` / `rejectionPrompt` 同步清理。
- push 模式终态从 `markTaskMerged(...)` 改为 `markTaskSuccess(..., null)`，与「Worker 终态只有
  success/failed/waiting」约束一致。
