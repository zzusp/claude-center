# 任务分类：工作类 vs 问答类

## 需求

任务分两大类，按是否产出代码改动区分流程：

1. **工作类（work）**：需要开发、修改文件，最终 commit / push / 开 PR。即现有 `executeTask` 全流程，**行为不变**。
2. **问答类（qa）**：纯对话问答，**不碰 git**（不建分支 / 不 commit / 不开 PR）。Claude 在项目本地目录里只读地回答，答案落成任务评论（备注）；用户通过评论与 Claude 多轮来回沟通，满意后手动「结束对话」标记完成。

生命周期决策（已与用户确认）：**多轮 + 手动结束**——每轮 Claude 回答后任务转 `waiting`，用户可在评论区继续追问、Claude 续接同一会话回答；用户点「结束对话」把任务标记为 `success`。

## 现状约束（已读源码确认）

- `tasks` 无类型字段，所有任务都走 `executeTask`：`git fetch/checkout/-B work_branch` → `claude` → 按 git 改动 commit/push/开 PR（`apps/worker/src/executor.ts:216` `finalizeTask`）。
- 已有「评论 ↔ 回复 ↔ 续接」机制：`waiting` 状态 + `task_comments` 表 + `claude_session_id`（migration `002`）。`claimNextResumableTask` 认领「有比最后一条 worker 评论更新的 user 评论」的 `waiting` 任务并续接（`packages/db/src/queries.ts:263`）。
- 工作树互斥：`claimNextTask` 当本 worker 在该 project 有 `waiting` 任务时不领新任务，避免 `git checkout` 清掉未提交改动（`queries.ts:166`）。
- Console 3s 短轮询 `/api/overview`；TaskDetail 有 概览/对话/时间线/日志 四 tab，对话区在 `waiting` 时可回复（`dashboard.tsx:899`）。

## 方案

### 数据模型（migration `005_task_types.sql`）

`tasks` 新增列 `task_type text NOT NULL DEFAULT 'work'`，CHECK `task_type IN ('work','qa')`。默认 `work` → 既有任务与未带类型的请求行为不变。

### Worker 流程

`executeTask` 按 `task.task_type` 分叉：

- **work**（不变）：建分支 → `runClaudeJson(taskPrompt)` → `handleClaudeTurn`（含哨兵则提问+等待，否则 commit/push/PR）。
- **qa**：**跳过所有 git 分支操作**，直接在 `localPath` 跑 `runClaudeJson(qaPrompt)` → `handleQaTurn`。

`resumeTask` 同样按类型分叉续接：work → `handleClaudeTurn`；qa → `handleQaTurn`。续接路径本就不动 git，保持一致。

`handleQaTurn`：存 `claude_session_id` → 把 `result` 作为 worker 评论落库 → `setTaskWaiting`。问答每轮恒定「答完即等待」，不用哨兵、不收尾 git。用户追问（user 评论）→ 下个 tick `claimNextResumableTask` 续接。

`qaPrompt`：要求 Claude **只读地回答关于该项目的问题，不修改任何文件**；答案直接作为对用户的回复正文。`qaResumePrompt`：把用户追问作为对话续接。

### 工作树互斥收窄（必须改）

`claimNextTask` 的排除条件加 `task_type='work'`：只有**等待中的工作类**任务（持有未提交改动）才锁住项目工作树、阻止领新任务；等待中的**问答类**任务是只读对话、不持有改动，**不应**阻止领新任务（否则一个长期开着的问答会冻结整个项目的任务流转）。

```sql
AND NOT EXISTS (
  SELECT 1 FROM tasks waiting
   WHERE waiting.project_id = tasks.project_id
     AND waiting.claimed_by = $1
     AND waiting.status = 'waiting'
     AND waiting.task_type = 'work'   -- 仅工作类等待任务锁工作树
)
```

注：等待中的工作类任务仍会阻止该项目领取**任何**新任务（含 qa），因为其工作树有未提交改动、不宜让别的任务在同目录跑 `claude`。这是安全取舍（最小改动 + 不污染半成品工作树）。

### 结束对话

新增 `completeQaTask(taskId)`：把 `task_type='qa'` 的任务置 `success` + `finished_at=now()`，写一条 `result.closedByUser`。用户在对话区点「结束对话」触发。

### Console

- API `/api/tasks` POST 增 `taskType`（`'work'|'qa'`，缺省 `work`）。qa 任务的 `base_branch`/`work_branch` 存空串、`target_files` 存空数组（这些字段对问答无意义）。
- API 复用任务状态切换端点 `PATCH /api/tasks/[id] { action: "complete" }` → `completeQaTask`（与 `publish` 同端点）。
- 发布表单：加「类型」选择（工作类 / 问答类）。选问答类时隐藏 基准分支 / 工作分支 / 目标文件（不适用），描述字段语义转为「问题」。
- 任务列表 / 详情：按类型显示——qa 不展示分支 / PR / 目标文件徽章，分支列显示「对话」；详情默认进「对话」tab，`waiting` 时对话框可继续追问并显示「结束对话」按钮。
- 状态徽章 / 色板复用现有（qa 收尾用 `success`「已完成」）。

## 验证

- 静态：`npm run typecheck`、`npm run build`、`npm run verify:console`（本会话可跑）。
- 端到端（需 Postgres + claude，待用户机器）：
  1. `npm run db:migrate` 应用 005。
  2. 发布一个「问答类」任务（如「这个仓库的 Worker 心跳间隔是多少？」）。
  3. 观察任务不建分支、Claude 回答落入对话区、任务转「等待回复」。
  4. 评论区追问 → Worker 续接 → 新答案落对话区。
  5. 点「结束对话」→ 任务转「已完成」，无 PR。
  6. 同时另发一个「工作类」任务，确认其建分支 / commit / 开 PR 流程不受影响，且开着的问答任务不阻塞它被领取。

## 边界

- 问答类不产出任何 git 改动；若 Claude 在问答里擅自改了文件，不会被 commit（finalize 路径不经过 qa），但会留在工作树——qaPrompt 明确要求只读以规避。
- 沿用短轮询、`task_comments` 单线程对话；不做富文本 / 附件。
