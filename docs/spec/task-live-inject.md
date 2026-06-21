# 执行中留言「直接注入」续接（无需等下一轮）

## 需求

任务详情「Claude Code 执行」Tab，用户可随时发送消息；消息**不应等到下一轮**才被消费，应直接注入当前 Claude 会话续接执行。

## 现状约束（已读源码确认）

- 回复框已对在途态（`claimed/running/waiting`）开放（`apps/console/app/ui/task-detail-session.tsx:90`），用户本就能随时发。
- Worker 一次性 `claude -p <prompt> --output-format json [--resume <session>]` 跑完一轮（`apps/worker/src/executor.ts`），无 stdin 流式输入。
- 一轮结束后 `handleClaudeTurn`：命中哨兵 → 落 worker 评论 + `setTaskWaiting`；否则直接 `finalizeTaskMultiRepo`（commit/PR/success）。
- 用户消息落 `task_comments(author='user')`，仅在「task 进入 `waiting` 后被 `claimNextResumableTask` 重新认领 → `resumeTask`」时经 `getPendingReply` 消费。
- **缺口**：`running` 轮若未命中哨兵就收尾 success，本轮执行期间用户发的消息**永远不会被消费**（被静默丢弃）；命中哨兵也要等整轮跑完 + 重新认领，是「下一轮」的延迟。

## 方案

把 `handleClaudeTurn` 的「无哨兵 → 收尾」改成「无哨兵 → 先看本轮执行期间有没有用户留言；有则**直接 `--resume` 同一会话注入续接**，没有才收尾」，并循环到某轮结束且确无新留言。

- 同一工作树、同一 Claude 会话续接，不翻 `waiting`、不经下一次认领循环、不依赖哨兵。
- 锚点沿用 `getPendingReply` / `listPendingReplyAttachments` 既有口径：「上一次 `resumed`/`rerun_started` 事件之后的 user 评论」。每次注入前补一条 `resumed` 事件推进锚点，保证同一批消息只消费一次、下一轮不重复注入。
- 命中哨兵分支（含 `auto_reply` 兜底）行为完全不变——Claude 显式提问时仍进 `waiting` 等人回复，由既有 `resumeTask` 流续接。
- 取消：循环每轮经 `runTaskClaude` 的 `onSpawn` 把新 Claude 子进程句柄回填给 runner（`entry.child`），取消时 `killProcessTree` 仍能杀到当前轮；被杀 → `runTaskClaude` reject → 抛出循环 → executor catch（`markTaskFailed` 在已 cancelled 时为 no-op，与单轮路径同构）。

### 为什么不做 stdin 流式注入（`--input-format stream-json`）

真正的「mid-token 注入」需把整条执行主路径从一次性 `claude -p --output-format json` 改为长驻 `--input-format stream-json --output-format stream-json` + 增量解析 + stdin 写入 + interrupt 协议，牵动 `executeTask/resumeTask/retryFailedTask`、JSON 解析、session 同步、取消、多仓收尾全链路；且本仓无「实跑真实 Claude 任务」的验证 harness（worker-Claude 特性历来按「静态验证 + 文档化手测步骤」交付，见 `docs/spec/task-comment-confirm.md` 验证节）。在 CLI 仍是按轮（turn）边界处理 stdin 消息的前提下，流式与本方案对用户可见行为一致（消息在 Claude 到达停止点时被本会话消费），但风险与不可验证面大得多。故选回路注入。

## 验证

- 静态：`npm run typecheck`、`npm run build`、`npm run verify:console`（本会话可跑）。
- 端到端（需 Postgres + claude + 真实任务，本环境无法跑，列出步骤待用户机器验证）：
  1. 发一个会跑一阵的任务（非 `auto_reply`）。
  2. 任务 `running` 期间，在「Claude Code 执行」Tab 发一条消息（如「顺便也更新下 README」）。
  3. 观察：本轮 Claude 结束后，时间线出现 `resumed`「用户执行中留言，直接注入续接」节点，Claude 带着该留言在同一会话续接，而非直接收尾 success。
  4. 不再发消息后，下一轮结束即正常收尾（commit/PR/success）。

## 边界

- 仍按 turn 边界注入（Claude 跑完当前轮才消费），不做 mid-token 打断。
- 复用既有表 / 事件 / 锚点，无 schema 变更、无新迁移。

## 扩展：非在途（终态）任务也可回复续接

上文「用户消息仅在 task 进入 `waiting` 后被 `claimNextResumableTask` 消费」已不再准确——回复续接现已覆盖**保留了 Claude 会话的终态**（`success` / `merged` / `failed` / `cancelled`，工作树 + session 均保留，见 `listActiveTaskIdsForWorker`）：

- 任务详情回复框（`apps/console/app/ui/task-detail-session.tsx`）对这些终态（且 `claude_session_id` 非空）开放，文案为「回复并续接」。`draft` / `scheduled` / `pending` 无会话，仍不开放。
- `claimNextResumableTask`（`packages/db/src/queries.ts`）的候选状态由 `waiting` 扩到 `waiting + REPLYABLE_TERMINAL_STATUSES`；终态分支额外要求 `claude_session_id IS NOT NULL`。命中后翻 `running` 并**清掉历史动作戳** `cancel_requested_at`（否则重新 running 的 `cancelled` 任务会被 cancel checker 误杀）与 `retry_requested_at`（回复 resume 已涵盖续接，无需再走 `retryFailedTask` 固定 prompt）。
- 续接走既有 `resumeTask` → `getPendingReply`（锚点不变）→ `finalizeTaskMultiRepo`（已有 PR 幂等复用、零改动判 `no_changes`），无新表 / 新迁移。
- 与「续接重试」按钮（`requestTaskRetry` → `claimNextRetryableTask` → `retryFailedTask`）并存：前者由**用户回复**触发、带回复内容续接；后者由**按钮**触发、用失败原因 prompt 续接。回复续接优先级更高（claim 循环里在前）。
