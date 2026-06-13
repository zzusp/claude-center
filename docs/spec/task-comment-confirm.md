# 任务执行中途确认（评论 ↔ 回复 ↔ 续接）

## 需求

Worker 执行任务时，若 Claude 遇到需要与用户确认才能安全推进的点，应：在任务下方留一条「提问」评论 → 用户在 Web Console 看到并回复 → Worker 检测到回复后，**续接同一个 Claude 会话**继续执行，直到完成或再次提问。

## 现状约束（已读源码确认）

- 任务生命周期 `tasks.status`：`pending→claimed→running→success/failed/cancelled`（`packages/db/migrations/001_init.sql:53`），无「等待用户输入」态。
- Worker 一次性调用 `claude -p <prompt>`（`apps/worker/src/executor.ts:24,95`），跑完即根据 git 改动决定 commit/PR，中途无法暂停。
- Console 靠 3s 短轮询 `/api/overview`（`apps/console/app/ui/dashboard.tsx:162`），无 WebSocket（MVP 边界：`docs/spec/claude-center-mvp.md:60`）。
- 已有 `task_events`（系统事件遥测）与 `direct_commands` 队列；TaskDetail 有 概览/时间线/日志 三 tab。

## Claude Code CLI 契约（已向 claude-code-guide 核实）

- `claude -p "<prompt>" --output-format json` → 返回 `{ session_id, result, total_cost_usd, ... }`。
- `claude -p "<reply>" --resume <session_id> --output-format json` → **可在独立进程、非交互续接**；会话落盘于 `~/.claude/projects/<project>/<session-id>.jsonl`，**续接必须在同一工作目录**。
- headless 无内建「需要提问」信号 → 约定**哨兵串**，让 Claude 输出后停下，Worker 解析 stdout。

工作目录约束天然满足：任务始终绑定 `worker_project_links.local_path`，同一 Worker（`claimed_by` 锁定）在同一目录续接。

## 方案

### 信号机制（哨兵）

任务 prompt 追加约定：需要用户决策时，不要猜，输出末行哨兵 `<<CLAUDE_CENTER_NEEDS_INPUT>>` + 问题，然后停止、不再改动。Worker 解析 `result`：含哨兵则取其后文本为问题。

### 数据模型（migration `002_task_comments.sql`）

- 新表 `task_comments`：`id / task_id(FK) / author('worker'|'user') / worker_id(NULL) / body / created_at`，索引 `(task_id, created_at)`。
- `tasks` 新增列 `claude_session_id text`（续接用）。
- `tasks.status` CHECK 增加 `'waiting'`（等待用户回复）。

「评论」与 `task_events`（系统遥测，带 event_type/payload）是不同概念，且需 author + 回复 UI，故新建独立表而非塞进 events。

### Worker 流程

`runner.tick()`：先认领定向指令 → 再认领 `pending` 新任务（`claimNextTask`）→ 再认领**自己的可续接任务**（`claimNextResumableTask`：`status='waiting' AND claimed_by=me AND 存在比最后一条 worker 评论更新的 user 评论`，原子翻转为 `running`）。

- 新任务 `executeTask`：git fetch/checkout/`-B work_branch` 建分支 → `runClaudeJson(prompt)` → `handleClaudeTurn`。
- 续接 `resumeTask`：**跳过 git 建分支**（保留 Claude 上一轮工作树改动）→ 取「最后一条 worker 评论之后的 user 评论」为回复 → `runClaudeJson(reply, resume=session_id)` → `handleClaudeTurn`。
- `handleClaudeTurn`：先存 `claude_session_id`；
  - 含哨兵 → `addTaskComment(worker, 问题)` + `setTaskWaiting` → 返回（不 commit/PR）。
  - 不含 → 走原 git status/commit/push/PR/`markTaskSuccess` 逻辑。

关键：续接路径不得 `checkout -B`，否则丢弃上一轮改动。

**工作树互斥（防数据丢失）**：任务 A 进入 `waiting` 后 `executeTask` 已返回，若不加约束，本 Worker 下个 tick 会领取同项目的 `pending` 任务 B，在**同一 `localPath`** 跑 `git checkout -B` 清掉 A 未提交的改动。故 `claimNextTask` 增加排除：`NOT EXISTS(同 worker 在该 project 有 status='waiting' 的任务)`。即「同 Worker 同项目工作树，同时只有一个活动/等待任务」；A 收尾（success/failed）后约束自动解除。不同项目（不同 localPath）互不影响。

### Console

- API：`app/api/tasks/[id]/comments/route.ts` —— `GET` 列出评论；`POST {body}` 追加 user 回复。
- UI：TaskDetail 增 「对话」tab，渲染评论流；`status='waiting'` 时显示回复输入框（其余状态禁用并提示）。`TaskConversation` 子组件按 `task.id` 自轮询（3s）。
- 状态色板：新增 `waiting` 色（`--waiting:#0891b2`）+ `STATUS_META.waiting`（label「等待回复」）+ `.badge/.dot[data-tone="waiting"]`。`/api/overview` 的 summary 把 `waiting` 计入「执行中」或单列；MVP 先并入运行中统计不变，仅状态徽章区分。

## 验证

- 静态：`npm run typecheck`、`npm run build`、`npm run verify:console`（本会话可跑）。
- 端到端（需 Postgres + claude + 真实任务，本环境无法跑，列出步骤待用户机器验证）：
  1. `npm run db:migrate` 应用 002。
  2. 发布一个任务，其目标故意含需确认点（如「重命名 X，若有歧义先问我」）。
  3. 观察任务进入「等待回复」、对话区出现 Claude 提问。
  4. Web 端回复 → Worker 下一 tick 续接 → 任务推进至完成/再次提问。

## 边界

- 不引入 WebSocket，沿用短轮询。
- 一次只取「最后一条 worker 评论之后」的 user 评论拼接为回复；不做富文本/附件。
- 续接依赖 Claude 会话磁盘持久化 + 同机同目录；跨机不支持（`claimed_by` 已锁定同机）。
