# 验收报告 —— 定时任务（到点自动进入待处理队列）

状态：**全绿**（matrix.csv C1–C15 全 PASS，round-1）。

## 结论

Web Console 新建任务可指定「定时发布」时间：任务落 `scheduled` 态，到点由 Console 后台
调度器（`apps/console/instrumentation.ts`）自动转 `pending`，进入可认领队列供在线 Worker
领取。三层验证均通过：DB 逻辑、真实 Next 服务进程内的调度器提升、真实 HTTP 入口校验与落态。

## 覆盖范围

- DB：`createTask`（scheduled / draft 分叉）、`promoteDueScheduledTasks`（到点提升 + 审计事件 + 幂等）、`publishTask`（放开 scheduled 立即发布）。
- 运行时：真起 `next dev`，instrumentation 调度器把过去时间的 scheduled 任务提升为 pending。
- HTTP：`POST /api/tasks` 对过去 / 非法时间返回 400，将来时间落 scheduled，无时间落 draft。
- 工程：typecheck / build / db:migrate / verify:console 全过。

## 复现配方

```powershell
npm install                      # worktree 首次
Copy-Item ..\..\..\.env .env     # worktree 需要 DATABASE_URL
npm run db:migrate               # 应用 009
node docs/acceptance/task-scheduled/scripts/verify-scheduled.mjs
node docs/acceptance/task-scheduled/scripts/verify-scheduler-runtime.mjs
node docs/acceptance/task-scheduled/scripts/verify-scheduled-api.mjs
```

脚本均建临时项目跑断言、结束 cascade 删除，不留脏数据；无大 binary 入库。

## 未覆盖 / 盲点

- 未做前端点击级 UI 自动化（表单 datetime-local 填写、徽章渲染）；表单逻辑经 build + 代码审阅确认，未做浏览器 e2e。
- 多 Console 实例并发跑调度器未压测；`promoteDueScheduledTasks` 的 `UPDATE ... WHERE status='scheduled'` 幂等，并发安全在逻辑上成立但未做并发实测。
