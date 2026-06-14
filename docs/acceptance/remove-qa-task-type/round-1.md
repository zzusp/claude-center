# Round 1 — 从任务流移除问答类（qa）

验证库：一次性干净库（`scripts/ephemeral-db.mjs`），不碰共享 dev 库；用完 `DROP ... WITH (FORCE)`，零污染。
Console 端口：`CONSOLE_PORT=3939`（避开主检出 dev server）。

## 1. typecheck — PASS

`npm run typecheck` → db / console / worker 三包 `tsc --noEmit` 全部无输出（无错）。

## 2. build — PASS

`npm run build`：
- console `next build` 成功，产出 20 个路由（`/`、`/tasks/[id]`、`/api/tasks` 等），无类型/编译错误。
- worker `tsc` 产出 dist。

## 3. ephemeral 全量迁移 — PASS

`node scripts/ephemeral-db.mjs --check` → 计划应用 **16** 个迁移，含新增 `016_task_drop_type.sql`，零副作用自检通过。

`node scripts/ephemeral-db.mjs --verify` → 建临时库 → 顺序应用全部 16 个迁移（`005` 加 `task_type` → `016` 删列+约束）无报错 → DROP 临时库。证明迁移在 fresh 库上自洽。

## 4. verify:console — PASS

对临时库起 console 并断言（实测输出）：

```
unauthOverviewStatus: 401
loginStatus:          200
pageStatus:           200
health.db.ok:         true   (latency 40ms)
health.scheduler.ok:  true   (tickCount 1)
```

`✓ verify:console 通过` / `✓ dropped database`。覆盖未登录拦截、登录、鉴权后首页渲染（首页走 `listRecentTasks` / overview 等 `SELECT *`，确认去掉 `task_type` 列后查询无 500）。

## 5. 源码零残留 — PASS

`grep -rniE "task_type|taskType|qaPrompt|completeQaTask|handleQaTurn|isQa"`（ts/tsx/sql/mjs/mts/cjs，排除 docs 历史快照）仅命中：
- `005_task_types.sql`（历史：ADD COLUMN，replay 时先建）
- `016_task_drop_type.sql`（本次：DROP COLUMN + DROP CONSTRAINT）

源码（types/queries/executor/api/ui）无任何 qa-as-tasktype 引用。

## 结论

全绿。任务流问答类（qa）相关字段 / 功能 / 设计已删干净，任务流只剩工作类一种形态；工作类的「中途确认（评论↔回复↔续接）」机制保留不动。
