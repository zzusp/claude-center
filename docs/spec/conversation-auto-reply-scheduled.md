# 实时对话：定时发送消息 + 自动回复

> 让「实时直连对话」（Worker Direct Chat，见 `worker-direct-chat.md`）具备两项与「任务表单」同款的设置，
> 且**新建对话**与**对话中**都能设置。

## 需求
1. **定时发送消息**：消息可排定到未来某时刻发送；时间控件复用任务表单的 `DateTimePicker`。
2. **自动回复**：与任务表单的「自动回复」同设计（`Select` off/on + 决策预案 `textarea`）。

## 设计抉择

### 自动回复 —— 会话级
与 `tasks.auto_reply`（迁移 021）同语义、复用其 UI 设计。落在 `conversations` 表：
- `auto_reply boolean`、`auto_decision_hints text`。
- Worker 执行对话轮（`executeConversationTurn`）时若 `auto_reply=true`，把「无人值守、自主决策、
  不停下来反问」的指令（含 `auto_decision_hints` 作为决策偏好）拼到 prompt 末尾。对话是只读问答场景
  （不 commit / 不开 PR），故指令措辞较任务版更轻（`conversationAutoReplyDirective`）。
- 可在「新建对话面板」设置，也可在对话中经「更多菜单 → 对话设置」改（`PATCH /api/conversations/[id]`）。

### 定时发送 —— 消息级
落在 `conversation_messages`：`scheduled_at timestamptz` + 新增 `'scheduled'` 状态。

**关键抉择：`seq` 改为可空，定时消息插入时 `seq=NULL`。** 定时消息在到点前不参与排序 / 派发 / prompt 锚点；
到点由 Console 调度器把 `'scheduled'` 翻 `'done'` 并赋 `seq = max(seq)+1`。
- 为什么不在插入时就给 seq？若提前排定（seq 较小）、晚于其后的 assistant 应答才触发，旧 seq 会落在该 assistant
  之后的「最新一条」判定之前，导致 `claimNextConversationTurn` / `getConversationPrompt` 的「上一已闭合
  assistant 之后」锚点漏掉它。到点才赋 seq → 触发时它恒为最新一条 user 消息，被正确认领。
- `UNIQUE(conversation_id, seq)` 对多个 NULL 不冲突（PG NULL 互不相等），多条待发定时消息可共存。
- 同会话多条同时到点：调度器用 `row_number()` 给它们赋连续 seq，避免唯一冲突。
- 受影响查询：`claimNextConversationTurn` 的「最后一条消息是 user」子查询加 `seq IS NOT NULL`（无视定时消息）；
  `getConversationPrompt` 加 `seq IS NOT NULL`；`publishConversationFinal` 取「最后一条已编号消息」。

可在「新建对话面板」（配合可选首条消息）设置，也可在对话中经输入框旁的定时控件设置
（`POST /api/conversations/[id]/messages` 带 `scheduledAt`）；未到点的定时消息在输入框上方排队展示、可取消
（`DELETE /api/conversations/[id]/messages/[messageId]`，仅 `scheduled` 可删）。

## 调度
Console 后台调度器（`instrumentation-node.ts`）在既有 30s tick 内，于提升定时任务之后顺带调
`promoteDueScheduledConversationMessages`（独立 try/catch，失败仅 warn）。提升后 Worker 下一轮
`tickConversation`（周期 + relay 信号）即认领——与定时任务「翻 pending 后等 worker 认领」同构，无需调度器直接 publish。

## 验证
见 `docs/acceptance/conversation-auto-reply-scheduled/`（matrix + round + e2e 脚本）。
