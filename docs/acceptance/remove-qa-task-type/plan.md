# 从任务流移除问答类（qa）

## 需求

任务流（`tasks`）此前混入了「问答类（qa）」任务类型：纯对话、不碰 git、答案落评论、手动「结束对话」。
问答的实时性要求高，与异步、可排队、走 PR/合并生命周期的任务流不是一回事，混在一起既污染数据模型也拖累交互。

**本次目标**：把任务流里所有问答类相关的设计 / 功能 / 字段删干净，任务流只保留工作类（建分支 → Claude → commit/PR）一种形态。
问答能力将来独立重做（单独菜单 + 单独数据通道、指定项目/分支、指定 Worker 直接对话），不在本次范围内。

> 注意：工作类任务执行中途的「评论 ↔ 回复 ↔ 续接」澄清机制（Worker 用哨兵 `<<CLAUDE_CENTER_NEEDS_INPUT>>` 提问、
> 用户在「对话」区回复、Worker 续接同一会话）**不是问答类**，是任务流自有能力，保留不动。

## 方案

`task_type` 字段唯一作用就是区分 `work` / `qa`；qa 删除后该列恒为 `'work'`，属死字段，连同 CHECK 约束一并删（不留兜底）。

- **DB**：新增迁移 `016_task_drop_type.sql` 删 `tasks.task_type` 列 + `tasks_task_type_check` 约束；`types.ts` 删 `TaskType`、`Task.task_type`；`queries.ts` 删 `completeQaTask`、`createTask` 去 `taskType`、`claimNextMergeCheckCandidate` 去 `task_type='work'` 过滤。
- **Worker**：`executor.ts` 删 `qaPrompt` / `qaResumePrompt` / `handleQaTurn` 及 `executeTask` / `resumeTask` 里的 `task_type==='qa'` 分支。
- **Console API**：`POST /api/tasks` 去 `taskType` 入参与 qa 置空分支；`PATCH /api/tasks/[id]` 删 `action:"complete"` 动作与 `completeQaTask` 导入。
- **Console UI**：删 `TaskTypeBadge`（含 6 处 import）、任务列表「类型」列、详情类型徽章/「类型」信息行、发布表单「类型」选择项、对话区「结束对话」按钮与全部 `isQa` 文案分叉；`dashboard.tsx` 提交去 `taskType` 表单字段。
- **文档**：README 删「任务分类」专节 + 真并发段去「问答类」措辞；`claude-center-mvp.md` 去 `task_type` 子句与 qa 执行分支；`task-types.md` 顶部加废弃横幅（保留历史快照，不重写正文）。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `packages/db/migrations/016_task_drop_type.sql` | 新增：DROP CONSTRAINT + DROP COLUMN |
| `packages/db/src/types.ts` | 删 `TaskType`、`Task.task_type` |
| `packages/db/src/queries.ts` | 删 `completeQaTask`、`createTask` 去 taskType、merge-check 去过滤、去 `TaskType` 导入 |
| `apps/worker/src/executor.ts` | 删 `qaPrompt`/`qaResumePrompt`/`handleQaTurn` + 两处 qa 分支 |
| `apps/console/app/api/tasks/route.ts` | 去 `taskType` 入参 + qa 置空分支 |
| `apps/console/app/api/tasks/[id]/route.ts` | 删 `complete` 动作 + `completeQaTask` 导入 |
| `apps/console/app/ui/shared.tsx` | 删 `TaskTypeBadge` + 其图标 import |
| `apps/console/app/ui/tasks.tsx` | 列表去「类型」列、发布表单去「类型」选择与 isQa 分叉 |
| `apps/console/app/ui/task-detail.tsx` | 去类型徽章/信息行、对话区去「结束对话」与 isQa 文案、`TaskConversation` 去 unused `canCreateTask` prop |
| `apps/console/app/ui/overview.tsx` | 分支列去 qa 三元 |
| `apps/console/app/ui/dashboard.tsx` | 提交去 `taskType` 表单字段 |
| `apps/console/app/ui/{workers,users}.tsx` | 去 unused `TaskTypeBadge` import |
| `README.md` / `docs/spec/claude-center-mvp.md` / `docs/spec/task-types.md` | 文档同步 |

## 验证

固定顺序（见 `CLAUDE.md`）：

1. `npm run typecheck` — db / console / worker 三包。
2. `npm run build` — 三包构建（含 next build）。
3. 临时干净库跑全量迁移（含 016）+ verify:console：`node scripts/ephemeral-db.mjs --verify`。

结果见 `round-1.md`。
