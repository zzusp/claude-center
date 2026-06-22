# 验收报告 — 实时对话：定时发送消息 + 自动回复

**结论：全绿。** 见 `matrix.csv` / `round-1.md`。

## 范围
让「实时直连对话」支持两项与任务表单同款设置，新建对话与对话中均可设置：
- 定时发送消息（消息级，`conversation_messages.scheduled_at` + `'scheduled'` 态 + 可空 `seq`，Console 调度器到点提升）。
- 自动回复（会话级，`conversations.auto_reply` + `auto_decision_hints`，Worker 执行轮注入无人值守指令）。

设计见 `docs/spec/conversation-auto-reply-scheduled.md`。

## 验证手段与结果
1. `npm run typecheck`（五包）— 通过。
2. `node scripts/ephemeral-db.mjs --verify` — 干净库跑全量 36 迁移（含 036）+ verify:console：`pageStatus 200`、`db.ok`、`scheduler.ok`，`✓ dropped`。
3. `npm run build`（五包，含 console webpack）— 通过。
4. `node docs/acceptance/conversation-auto-reply-scheduled/scripts/e2e-queries.mjs` — **PASS 22 / FAIL 0**，覆盖定时消息全生命周期、自动回复持久化/更新、定时取消。

## 本环境未覆盖（需真实 Worker + claude CLI + 在线关联项目）
- Worker 端把会话自动回复指令注入 claude 后的实际对话表现（拼接逻辑由 typecheck + 审阅保证）。
- 浏览器手点 UI 流（可编译可渲染由 typecheck + verify:console 启动保证）。
