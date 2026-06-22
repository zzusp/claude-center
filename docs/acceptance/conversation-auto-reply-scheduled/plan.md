# 实时对话：定时发送消息 + 自动回复（验收）

## 需求
实时对话（Worker Direct Chat）要支持两项与「任务表单」同款的设置，且**新建对话**与**对话中**都能设置：
1. **定时发送消息**：消息可排定到未来某时刻发送（时间控件复用任务表单的 `DateTimePicker`）。
2. **自动回复**：与任务表单的「自动回复」同设计（off/on 的 `Select` + 决策预案 `textarea`）。

## 方案
- **自动回复 = 会话级**（与 `tasks.auto_reply` 同语义，复用其设计）：`conversations.auto_reply` + `auto_decision_hints`。
  Worker 执行对话轮时若开启，则把「无人值守、自主决策、不停下来问」指令（含决策预案）拼到 prompt 末尾。
- **定时发送 = 消息级**：`conversation_messages.scheduled_at` + `'scheduled'` 状态；`seq` 改为可空，
  定时消息插入时 `seq=NULL`（不占序号、不参与排序/派发/prompt 锚点），由 Console 调度器到点翻 `done` 并赋 `max(seq)+1`，
  故触发时它恰是最新一条 user 消息，Worker 下一轮 `tickConversation` 认领。
- 两项均可在「新建对话面板」与「对话中（更多菜单→对话设置 / 输入框旁的定时控件）」设置。

## 改动（详见 PR 描述 Changes）
- 迁移 `036_conversation_auto_reply_scheduled.sql`
- `packages/db`：types + queries（create/update/add/promote/delete/claim/prompt）
- `apps/console`：conversations API（POST/PATCH/messages POST + DELETE）、instrumentation 调度器、chat UI
- `apps/worker`：executor 注入会话自动回复指令；runner 适配可空 seq

## 验证
- `npm run typecheck`（五包）
- `node scripts/ephemeral-db.mjs --verify`：干净库跑全量 36 个迁移 + verify:console（401→200 + scheduler.ok）
- `node docs/acceptance/conversation-auto-reply-scheduled/scripts/e2e-queries.mjs`：干净库直接驱动新查询函数，
  断言定时消息生命周期（插入→不被认领→到点提升→可认领）、自动回复持久化、设置更新、定时取消。
- 全绿见 `matrix.csv` / `round-1.md`。
