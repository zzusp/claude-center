# 验收:Worker 桌面应用功能完善

方案见 `docs/spec/worker-app-enhancements.md`。本次按四个方向完善 worker:① 桌面 UI 增强 ② 项目关联可视化 ③ 任务可控性(取消 + 能力自检) ④ 健壮性/可观测。

## 改动清单(file:line 关键点)

- `packages/db/migrations/015_task_cancel_request.sql` — 新增 `tasks.cancel_requested_at`(additive)
- `packages/db/src/queries.ts` — 新增 `requestTaskCancellation` / `listCancelRequestedTaskIds` / `markTaskCancelled` / `listWorkerProjectLinks` / `removeWorkerProjectLink`;`markTaskFailed` 加 `status <> 'cancelled'` 守卫
- `packages/db/src/types.ts` — `Task.cancel_requested_at` + `WorkerProjectLinkView`
- `apps/worker/src/shell.ts` — `onSpawn` 回调暴露子进程 + `killProcessTree`(win32 taskkill /T /F)
- `apps/worker/src/inspect.ts` — `detectCapabilities`(git/gh/claude --version 自检)
- `apps/worker/src/config.ts` — `WorkerState` 持久化 projects/maxParallel;`persistWorkerState` 读改写;env∪本地项目合并(source 标记)
- `apps/worker/src/executor.ts` — `ExecHooks` 透传 onSpawn + claude 预检;`committed`/`pushed`/`pr_created` 事件
- `apps/worker/src/runner.ts` — 进程注册表(ActiveEntry)、取消扫描定时器、富快照、项目/并发设置、内存日志环
- `apps/worker/src/main.ts` + `preload.cjs` — 扩展 IPC + 富渲染界面(状态/用量/能力/项目/在途/日志)
- `apps/console/app/api/tasks/[id]/route.ts` — PATCH 新增 `action:"cancel"` → `requestTaskCancellation`
- `apps/console/app/ui/task-detail.tsx` — 在途态显示「取消任务」按钮

## 验证手段

后台会话无法驱动 Electron GUI 与真实长时 Claude 任务端到端,故对**机制子单元**做脚本级实跑验证 + 全 workspace typecheck/build:

- typecheck(db/console/worker)+ worker build:全过(见 round-1)
- `scripts/verify-db-queries.mts`:对 dev 库 seed 临时 project/worker/task,验证取消流(请求→列举→标记→`markTaskFailed` 守卫不覆盖)+ 项目关联 list/remove,跑完清理
- `scripts/verify-kill-tree.mts`:spawn `powershell Start-Sleep 60` → `killProcessTree` → 断言进程被终结
- `scripts/verify-config-capabilities.mts`:`detectCapabilities` 返回 git/gh/claude 自检;`worker.json` 读改写 round-trip(maxParallel/projects/allowRemoteControl 合并保留);`readWorkerConfig` env∪本地项目去重合并 + source 标记
