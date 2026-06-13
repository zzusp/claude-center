# Round 1 —— 定时任务验证

环境：Windows 11 / PowerShell 7 / Node v22 / 远程 dev Postgres（worktree `.env`）。
迁移：`npm run db:migrate` 应用至 `009_task_scheduled.sql`。

## 命令与证据

### 1. DB 层（C1–C7）：`node docs/acceptance/task-scheduled/scripts/verify-scheduled.mjs`

```
PASS  建将来定时任务 → status=scheduled（实际 scheduled）
PASS  将来定时任务 scheduled_at 已写入
PASS  不指定时间 → status=draft（实际 draft）
PASS  草稿任务 scheduled_at 为空
PASS  建过去定时任务 → status=scheduled（实际 scheduled）
PASS  promoteDueScheduledTasks 提升条数 ≥1（实际 1）
PASS  过去定时任务到点 → 已转 pending
PASS  将来定时任务未到点 → 仍 scheduled
PASS  草稿任务不受调度器影响 → 仍 draft
PASS  提升后写入 scheduled_published 事件
PASS  对 scheduled 任务 publishTask → pending（实际 pending）
PASS  无到点任务时再提升返回 0（实际 0）
ALL PASS
```

### 2. 调度器运行时（C8）：`node docs/acceptance/task-scheduled/scripts/verify-scheduler-runtime.mjs`

真起 `next dev`（`CLAUDE_CENTER_SCHEDULER_INTERVAL_MS=1500`），种一个过去时间的 scheduled 任务，轮询直到服务端 instrumentation 调度器把它翻成 pending。

```
seed: task 7a5a707e-498c-4a6a-a8a9-386a6dab39fc status=scheduled
final: task status=pending
PASS  调度器在运行时把到点定时任务提升为 pending
```

### 3. HTTP 入口（C9–C11）：`node docs/acceptance/task-scheduled/scripts/verify-scheduled-api.mjs`

真起服务 + 管理员登录 + 真发 `POST /api/tasks`：

```
PASS  管理员登录拿到会话 cookie（status 200）
PASS  过去 scheduledAt → 400（实际 400）
PASS  非法 scheduledAt → 400（实际 400）
PASS  将来 scheduledAt → 201（实际 201）
PASS  将来定时任务 status=scheduled（实际 scheduled）
PASS  将来定时任务 scheduled_at 已写入
PASS  无 scheduledAt → 201（实际 201）
PASS  无 scheduledAt → status=draft（实际 draft）
ALL PASS
```

### 4. 构建 / 类型 / 迁移 / dev 健康（C12–C15）

- `npm run typecheck` → db/console/worker 三包全过。
- `npm run build` → `✓ Compiled successfully` + 静态页生成完成（含 `instrumentation.ts` 编译）。
- `npm run db:migrate` → `Applied 009_task_scheduled.sql`。
- `npm run verify:console` → `{"unauthOverviewStatus":401,"loginStatus":200,"pageStatus":200,...}`。

## 踩坑记录（已修复）

`instrumentation.ts` 经 `@claude-center/db` 引入 `pg`，webpack 编译 instrumentation 模块图（含 edge/fallback）时报 `Module not found: Can't resolve 'fs'`（pg 内部按需 `require('fs')`），拖垮整个 dev server 所有路由 500。`serverExternalPackages: ["pg"]` 无效（edge 编译不吃）。最终用 `await import(/* webpackIgnore: true */ "@claude-center/db")` 让 webpack 完全不追踪此动态 import、运行时由 Node 解析（仅 nodejs runtime 执行），修复后 dev 健康 + 调度器照常工作。
