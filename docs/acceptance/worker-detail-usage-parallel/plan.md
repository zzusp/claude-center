# Worker 详情增强 + 工作态门控 + 真并发执行 — 验收

## 需求

执行机群 worker 卡片点击详情，新增：Claude Code 版本、订阅类型（API 计费 vs 套餐）、套餐用量（5h/7d 已用率 + 重置剩余）、并行处理任务列表、并行上限。
工作态门控：在线 ≠ 接任务，需切到「工作状态」（客户端 + web 远程两个开关，远程受客户端「允许远程」策略约束），默认空闲。
执行模型：从严格串行改为真并发（可配上限），同项目并发用 git worktree 隔离工作树。

设计详见 `docs/spec/worker-detail-usage-parallel.md`（含数据源实测）。

## 改动

- **DB**：`packages/db/migrations/012_worker_detail_working_state.sql` 给 workers 加 6 列（additive）；`types.ts` 扩 Worker；`queries.ts` 改 `registerWorker`（保留 working_state）/`listWorkers`（派生 active_task_count），新增 `updateWorkerInfo`/`setWorkerWorkingState`（远程门控）/`getWorkerRuntime`/`listActiveTaskIdsForWorker`。
- **Worker**：新增 `inspect.ts`（claude 版本/订阅/用量采集）、`worktree.ts`（工作树隔离）；`config.ts` 加 maxParallel/allowRemoteControl/usageProxy/dataDir/infoInterval + worker.json 持久化；`runner.ts` 重写为并发调度 + 工作态门控 + info 定时上报 + 启动 GC；`executor.ts` 各 flow 改用每任务 worktree；`main.ts` + `preload.cjs` 加 Electron 两开关 IPC。
- **Console**：新增 `POST /api/workers/[id]/working-state`（command.create + 远程门控）；`dashboard.tsx` 详情抽屉补全新字段（版本/订阅/用量条/并行列表/上限/工作态徽标 + 远程开关），卡片加工作态/claude 版本/在途数。

## 验证（round-1 全绿）

| 维度 | 方式 | 结果 |
|---|---|---|
| 三层类型/构建 | db/worker/console typecheck + build | PASS |
| 迁移 | 应用到 dev 库 + 列存在校验 | PASS |
| DB 查询行为 | `scripts/db-queries.mts`（事务 ROLLBACK） | PASS |
| 采集链路 | 本机 inspectClaude 实跑（版本/订阅/用量） | PASS |
| worktree 隔离 | `scripts/worktree-isolation.mts`（临时 git 仓库） | PASS |

证据见 `round-1.md`，状态以 `matrix.csv` 为准。

## 未覆盖（诚实标注）

- Electron 窗口两开关：类型 + IPC 接线 + 构建已过，但后台无显示环境，未点击实测。
- 端到端单任务经 worktree 跑真 Claude：worktree 机制已实测，executor 接线已 typecheck，但未跑完整任务（需真项目 + claude run）。
