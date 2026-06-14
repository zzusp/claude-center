# Round 1 — 任务级 model 验证

环境：worktree `task-model-select`，基于最新 main（e07455e，含 worktree 真并发执行）。
共享 dev 库；DB 验证全程事务回滚，不污染。

## C7 typecheck（db / console / worker）— PASS
`npm run typecheck` 三包均无错误输出。

## C8 console build — PASS
`npm -w @claude-center/console run build` 成功，产物含 `/tasks/[id]`、`/api/tasks` 等，无报错。

## C1 migration — PASS
`npm run db:migrate` 输出 `Applied 013_task_model.sql`。
脚本 `scripts/verify-model.mts` [1] 查得：
`model column: {"data_type":"text","column_default":"'default'::text"}`。

## C2 createTask 落库读回 — PASS
`scripts/verify-model.mts` [2]：真实 `createTask({ model: "opus" })` →
`createTask model = opus (expect opus)`。

## C3 非法 model 被拒 — PASS
`scripts/verify-model.mts` [3]：插入 `model='gpt5'` →
`illegal model rejected: new row for relation "tasks" violates check constraint "tasks_model_check"`。
末尾 `RESULT: PASS`，并 `rolled back — dev db unchanged`。

## C4/C5/C6 worker --model 拼接 — PASS
`scripts/verify-claude-args.mts`（镜像 executor.ts:runClaudeJson 两分支拼接，源码为权威）：
- C4 `argv opus` / `pwsh opus`：均含 `--model opus`。
- C5 `argv default no --model` / `pwsh default no --model` / `argv undefined no --model`：均不含 `--model`。
- C6 `argv sonnet+resume order`：`-p p --model sonnet --resume uuid-1 ...`，`--model` 在 `--resume` 前。
末尾 `RESULT: PASS`。
