# 验收报告 — 细颗粒度任务事件时间线 + 失败/取消续接重试

分支 `feature/task-event-timeline-retry`。Round 1(2026-06-16)。

## 结论

可在本环境验证的全部用例(C1–C9)**全绿**:静态链(typecheck/build)、一次性干净库迁移 + 鉴权链、DB 状态机逻辑(24/24 断言)均通过。需 live Worker/Claude/浏览器的端到端用例(C10–C14)在本会话不可复现,标 `N/R`,逻辑经 typecheck+build+源码审查,待真机环境补 round-2。

## 已验证(PASS)

| 维度 | 结果 |
|---|---|
| typecheck 五包 | PASS |
| build 五包(含 next build) | PASS |
| 干净库 22 迁移(含 022)+ verify:console 401→200 + DROP | PASS |
| 事件补全:published / claimed 落库 | PASS |
| 失败续接重试:requestTaskRetry → claimNextRetryableTask(机器锁定、翻 running、清戳) | PASS |
| reactivate 清 retry_requested_at | PASS |
| 取消续接重试 | PASS |
| 非可重试态守卫 | PASS |

证据见 [round-1.md](./round-1.md)、[matrix.csv](./matrix.csv);可复跑脚本 `scripts/retry-statemachine.mjs`。

## 交付要点

- **细颗粒度时间线**:补全 `published`/`claimed`/`resumed`/`rerun_started`/`retry_started` 等断点事件 + 执行编排子步骤(`worktree_prepared`/`committed`/`pushed`/`pr_created`/`claude_turn_finished` …);前端 `EVENT_META` 全集中文化、按「执行轮次」折叠展示、失败/取消节点挂「续接重试」、节点跳「Claude Code 执行」Tab 看 transcript。
- **失败/取消续接重试**:复用打回重跑机制,`failed`/`cancelled` → `running`,保留工作树 + Claude 会话精确恢复未提交改动,失败原因/中断点作为新一轮输入。三处入口:Console 详情头、时间线失败节点、Worker 桌面端。

## 待真机补验(N/R)

C10–C14:Worker 执行埋点端到端落库、保留工作树后 `retryFailedTask` 复用、时间线交互 UI、桌面端按钮。需 live Worker + Claude CLI + GitHub 远程 + 浏览器。
