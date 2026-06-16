# Round 1 — 2026-06-16

分支 `feature/task-event-timeline-retry`。本轮验证静态链 + DB 状态机逻辑(C1–C9 全 PASS)。

## C1 typecheck 五包 — PASS

`npm run typecheck` → db / relay-client / console / worker / relay 五包 `tsc --noEmit` 全过,无输出错误。

## C2 build 五包 — PASS

`npm run build` → 五包构建全过;`next build` 成功(`✓ Compiled successfully`,7 页静态生成,含 `/tasks/[id]`、`/api/tasks/[id]`)。

## C3 ephemeral 干净库迁移 + verify:console — PASS

`node scripts/ephemeral-db.mjs --verify`:

```
✓ created database claude_center_ephemeral_1781582917839
  applied 001_init.sql … applied 022_task_retry_request.sql   （22 个全量应用）
✓ migrations applied
>> verify:console（CONSOLE_PORT=60154）
  unauthDashboardStatus: 401, loginStatus: 200, pageStatus: 200
  health.db.ok=true (latency 75ms), scheduler.ok=true
✓ verify:console 通过
✓ dropped database claude_center_ephemeral_1781582917839
```

迁移 022 干净落地、约束无冲突;鉴权 401→登录→200 闭环;临时库 DROP 零污染。

## C4–C9 DB 状态机逻辑 — PASS（24/24 断言)

`node docs/acceptance/task-event-timeline-retry/scripts/retry-statemachine.mjs`(真临时库建→迁移→驱动→断言→DROP):

```
[1] 事件补全:published / claimed — 5/5 ✓
[2] 失败续接重试:requestTaskRetry / claimNextRetryableTask / 机器锁定 — 9/9 ✓
[3] reactivate 清空 retry_requested_at — 4/4 ✓
[4] 取消续接重试 — 4/4 ✓
[5] 守卫:非 failed/cancelled 不可重试 — 2/2 ✓
结果:PASS=24 FAIL=0
✓ dropped claude_center_retrytest_...
```

关键断言已核验:
- `publishTask`/`claimNextTask` 各落 `published`/`claimed` 事件(补断点)。
- `requestTaskRetry` 置 `retry_requested_at` + 落 `retry_requested` 事件,**状态仍 failed**(不直接翻 running,与打回链一致)。
- `claimNextRetryableTask` 仅本机(claimed_by)能认领,翻 running 并清 `retry_requested_at`。
- `reactivateTask` 清 `retry_requested_at` + `claimed_by` 回 draft。
- `cancelled` 与 `failed` 同样可续接重试;`draft`/`running` 被守卫挡回 null。

## C10–C14 — N/R（本环境不可 e2e）

无 live Worker / Claude CLI / GitHub 远程 + 无浏览器,执行器埋点端到端落库、时间线交互 UI、桌面端按钮交互无法在本会话实跑。代码经 typecheck + build,逻辑见 spec §3–4 与源码审查。待部署/真机环境补 round-2 e2e。
