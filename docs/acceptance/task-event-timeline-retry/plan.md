# 验收:细颗粒度任务事件时间线 + 失败/取消续接重试

> 方案全文见 [docs/spec/task-event-timeline-retry.md](../../spec/task-event-timeline-retry.md)。本文件记需求 + 改动 + 验证口径。

## 需求

任务详情时间线节点太粗。需要:① 一条更细颗粒度的事件时间线,从「认领」到「人工验收」补全所有节点,并下探到 Worker 执行编排子步骤;② 失败/取消的事件节点可「续接重试」(保留上下文接着干)。

需求方拍板(2026-06-16):保留工作树、加列 `retry_requested_at`、增强事件全做、取消也给重试。

## 改动(file:line 见 spec §5)

- **DB**(`packages/db`):迁移 `022_task_retry_request.sql` 加 `tasks.retry_requested_at` + 部分索引;`task-state.ts` 加 `RETRYABLE_STATUSES` + `TASK_RUNTIME_FIELDS` 补字段;`queries.ts` 补 `published`/`claimed` 事件、新增 `requestTaskRetry`/`claimNextRetryableTask`、`reactivateTask` 清 `retry_requested_at`、`listActiveTaskIdsForWorker` 纳入 failed/cancelled(GC 豁免);`types.ts` 加字段。
- **Worker**(`apps/worker`):`executor.ts` 补 `resumed`/`rerun_started`/`retry_started`/`worktree_prepared`/`claude_turn_finished` 事件、去掉三处 catch 的 `removeWorktree`(保留树)、新增 `retryFailedTask`+`retryPrompt`;`runner.ts` 加 retry 车道(续接>打回>重试>新任务)+ `retryMyTask`;`main.ts`/`preload.cjs` 桌面端重试按钮 + IPC。
- **Console**(`apps/console`):`api/tasks/[id]/route.ts` 加 `action=retry`;`task-detail-shared.tsx` `EVENT_LABEL`→`EVENT_META` 全集 + 分组集合;`task-detail-timeline.tsx` 轮次分组/折叠/失败节点重试/payload 展开/跳执行 Tab;`task-detail.tsx` 续接重试 + 激活回草稿双按钮;`globals.css` 样式。

## 验证口径

- 固定本地链:`typecheck` → `build` → 一次性干净库 `ephemeral-db.mjs --verify`(迁移全量 + verify:console 401→200 + DROP)。
- DB 状态机逻辑:`scripts/retry-statemachine.mjs` 真临时库驱动 + 断言(published/claimed 事件、requestTaskRetry/claimNextRetryableTask、机器锁定、reactivate 清戳、cancelled 重试、守卫)。
- 状态以 [matrix.csv](./matrix.csv) 为准;证据见 [round-1.md](./round-1.md)。
- **本环境无 live Worker/Claude/GitHub + 无浏览器**,执行器埋点的端到端事件落库、时间线交互 UI、桌面端按钮交互列为 `N/R`(代码经 typecheck+build,逻辑审查;真机 e2e 待部署环境)。
