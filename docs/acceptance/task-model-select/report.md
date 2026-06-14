# 验收报告 — 任务级 Claude 执行模型

状态：全绿（matrix.csv round-1 全 PASS）。

## 结论
创建任务时可选执行 model（默认 / Opus / Sonnet / Haiku）。`default` 不传 `--model`，跟随
claude 自身默认；其余经 Worker 拼为 `claude --model <alias>`，对 worktree 执行的工作类、
问答类、续接、打回重跑全部生效。旧任务默认 `default`，行为不变。

## 端到端链路
Console 创建表单选 model → `POST /api/tasks` 白名单校验 → `createTask` 写 `tasks.model`
→ Worker 领取（`RETURNING tasks.*` 带出 model）→ `runClaudeJson` 按 model 拼 `--model`。

## 验证
- typecheck db/console/worker、console build：通过。
- DB：migration 013 应用；`createTask(model=opus)` 落库读回；非法值被 CHECK 拒绝（事务回滚）。
- Worker：`--model` 拼接对 opus/sonnet/default/undefined/resume 组合断言通过。

详见 plan.md / matrix.csv / round-1.md，脚本 scripts/verify-model.mts、scripts/verify-claude-args.mts。
