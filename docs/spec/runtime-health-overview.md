# 系统运行状态总览（健康卡片 + 轮询统一）

## 背景

「实时同步、数据库连接、Web 端定时任务」这三样此前各自分散，且总览页只有业务量卡片、没有运行健康视图。本次把**可观测性**补齐，并顺手收敛散落的客户端轮询。

三者本质上分属三个执行上下文，**代码不强行合并**（合并是分类错误）：

| | 位置 | 运行处 | 性质 |
| --- | --- | --- | --- |
| 数据库连接 | `packages/db/src/client.ts` 单例 `Pool({max:10})` | Console 服务进程 + Worker 进程 | 共享基础库，已在规范位置 |
| 定时调度器 | `apps/console/instrumentation.ts` `setInterval` | Console 服务端后台循环 | 进程生命周期任务，已在 Next 启动钩子 |
| 实时同步 | `dashboard.tsx` / `task-detail.tsx` 客户端轮询 | 浏览器 | 看板自身刷新行为，非后端基础设施 |

因此本次只做两件**正交**的事：把三者的运行状态汇到总览页 + 统一轮询节奏。

## 改动

### 1. 数据库连接可观测

- `packages/db/src/client.ts`：抽出 `POOL_MAX` 常量；新增 `getPoolStats()`（同步读 `totalCount/idleCount/waitingCount` + max）与 `pingDatabase()`（`SELECT 1` 测往返毫秒）。
- `packages/db/src/queries.ts`：新增 `countScheduledTasks()`（当前 `scheduled` 待发队列深度）。

### 2. 调度器状态暴露

- `apps/console/app/lib/scheduler-state.ts`（新增）：调度器运行状态存于 `globalThis`（Symbol.for），因为 `instrumentation.ts`（写）与 `/api/overview`（读）在 Next 下可能落在不同 webpack bundle，模块级变量不保证同实例。记录 `startedAt / intervalMs / lastTickAt / lastError / lastPromoted / totalPromoted / tickCount`；`isSchedulerHealthy()` 判定「已启动且最近一次 tick 无错且在约 3 个周期内」。
- `apps/console/instrumentation.ts`：`recordSchedulerStart` + 每次 tick `recordSchedulerTick`。Worker 与原调度逻辑零改动。
- **限制**：纯内存态，单 Console 进程成立；将来多实例时是 per-instance 视图。

### 3. 健康数据折进 `/api/overview`

- `apps/console/app/api/overview/route.ts`：响应新增 `health` 块 = `{ db: { ok, latencyMs, pool }, scheduler: {...state, scheduledPending, ok } }`。`pingDatabase` + `countScheduledTasks` 并入既有 `Promise.all`。
- **为何不另开 `/api/health`**：总览页已每 3s 轮询 `/api/overview`，把健康数据搭这趟车 = 零额外请求，正好服务「轮询统一」目标；另开一个被 3s 轮询的端点会多一个定时器，与目标相悖。需要给外部 uptime 探针用时，再拆独立无鉴权端点即可。

### 4. 总览三张健康卡

- `apps/console/app/ui/dashboard.tsx`：4 张业务量卡之后新增「系统运行状态」区，三张卡——数据库连接（延迟 / 连接池 / 等待队列）、定时调度器（周期 / 上次检查 / 待发 / 累计提升 / 最近错误）、实时同步（轮询节奏 / 上次同步）。
- `globals.css`：新增 `.grid-3` + `.health-section` / `.health-body`，复用既有 `.card` / `.badge` / `.kv-row`，窄屏收一列。

### 5. 轮询统一

- `apps/console/app/lib/use-polling.ts`（新增）：`POLL_INTERVAL_MS = 3000` 单一常量 + `usePolling(effect, deps, intervalMs?)` 共享 hook（挂载即跑 + 周期跑 + 卸载清理 + `isActive()` 丢弃过期结果）。
- 替换 5 处散落的 `setInterval(…, 3000)`：`dashboard.tsx` ×2、`task-detail.tsx` ×3。各 poll 仍按自身 deps/端点独立运行（不强行并一个定时器——耦合是错的），统一的是常量与样板。
- 副作用：task 详情首屏多一次即时拉取（原 task 轮询无即时拉取），更新鲜，无害。

## 验证

`CONSOLE_PORT=3457 npm run verify:console` 全绿（已给 `verify-console.mjs` 补 health 断言）：

- 未登录 `/api/overview` → 401；登录 → 200；首页 → 200。
- `health.db`：`ok:true`、`latencyMs:43`、pool `{total:6,idle:6,waiting:0,max:10}`。
- `health.scheduler`：`tickCount:1`、`startedAt`/`lastTickAt` 已填、`ok:true` —— 证明 globalThis 跨模块图共享（写在 instrumentation、读在 route）通了。

`npm run build`（db→console→worker）通过，含 Next 的 lint + 类型检查。
