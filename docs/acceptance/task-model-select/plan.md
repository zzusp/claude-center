# 任务级 Claude 执行模型（model）

## 需求
创建任务时可指定该任务执行（worktree 内跑 Claude）用哪个 model。默认不指定，跟随
Worker/claude 自身默认；可选 Opus / Sonnet / Haiku。

## 决策（用户确认）
- 基线：当前最新 main（worker 已是 git worktree 真并发执行，见 apps/worker/src/worktree.ts）。
- 粒度：任务级，创建任务时选。
- 取值：固定下拉 `default / opus / sonnet / haiku`，`default` 表示不传 `--model`。

## 改动
1. **packages/db/migrations/013_task_model.sql**（新建）：`tasks` 加 `model text NOT NULL
   DEFAULT 'default' CHECK (model IN ('default','opus','sonnet','haiku'))`。additive 幂等。
2. **packages/db/src/types.ts**：新增 `TaskModel` 联合类型；`Task` 加 `model: TaskModel`。
3. **packages/db/src/queries.ts**：`createTask` 入参加 `model`，INSERT 增加 `model` 列与 `$11`。
4. **apps/console/app/api/tasks/route.ts**：`TASK_MODELS` 白名单；`body.model` 校验后传
   `createTask`（非法/缺省落 `default`）。work / qa 都透传。
5. **apps/console/app/ui/dashboard.tsx**：创建任务表单加「执行模型」下拉 + state + 提交带 model。
6. **apps/console/app/ui/task-detail.tsx**：详情页加「执行模型」展示行（设置闭环可见）。
7. **apps/worker/src/executor.ts**：`runClaudeJson` 入参加 `model`，`modelArg = model && model
   !== 'default' ? model : null`，两分支（PowerShell / 直接 argv）按需拼 `--model`；5 处调用
   （executeTask 工作/问答、resumeTask 工作/问答、rerunRejectedTask）传 `task.model`。

worker 三条领取查询（claimNextTask / claimNextResumableTask / claimNextRejectedTask）均
`RETURNING tasks.*`，新列自动带出，无需改查询。

## 验证
见 matrix.csv（用例总表）与 round-1.md（证据）。脚本在 scripts/。
