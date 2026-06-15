# task-auto-reply — 任务级自动回复（兜底）

## 需求
原架构里 Claude 中途用哨兵 `<<CLAUDE_CENTER_NEEDS_INPUT>>` 停下后任务落 `waiting` 等人回复。要做到"夜里发任务、一觉醒来全跑完"的无人托管，需要一个任务级开关在不破坏默认人工回复体验的前提下兜底。

## 方案

分层设计："先尽量让 Claude 不想问，问了再兜底"。

**主防线（提示词层）**：`task.auto_reply=true` 时 `taskPrompt` / `resumePrompt` / `rejectionPrompt` 切换激进版指令：
- "You run UNATTENDED. No human is watching."
- 列举不该停的情况（偏好 / 范围 / "is this enough" / "should I also X"）
- 把哨兵从"求助信号"重新定义为"任务被判定 blocked"
- 可选 `auto_decision_hints` 拼入 prompt 作为用户预先编码的决策偏好

**兜底层（仍出哨兵时）**：
- 零改动 → `markTaskFailed`（任务多半描述不全，再问也是同样结果）
- 有改动 → 自动塞一条 user 评论 "Commit what you have and finish in one shot..." 走现有 resumable 流；`task_events('auto_reply')` 计数 cap=2，超出则 fail

**默认不开**：`auto_reply` 默认 `false`，行为与改动前一致。

## 改动

| 文件 | 改动 |
|---|---|
| `packages/db/migrations/021_task_auto_reply.sql` | 新增；ALTER TABLE 加 `auto_reply boolean DEFAULT false` + `auto_decision_hints text DEFAULT ''` |
| `packages/db/src/types.ts` | `Task` 接口加两字段 |
| `packages/db/src/queries.ts` | `createTask` / `updateTask` 入参 + SQL 占位符扩展 |
| `apps/worker/src/executor.ts` | 顶部常量 `AUTO_REPLY_MAX_ROUNDS=2` + `AUTO_REPLY_CANNED` + `countAutoReplyRounds`；`autoReplyDirective` / `manualReplyDirective` / `replyDirective`；三个 prompt 函数接 `task`；`handleClaudeTurn` 新增 auto_reply 分支 |
| `apps/console/app/ui/tasks.tsx` | 创建表单加自动回复 Select + 决策预案 textarea |
| `apps/console/app/ui/task-detail.tsx` | 编辑表单同款 + 详情 KvRow |
| `apps/console/app/(app)/tasks/tasks-client.tsx` | POST body 加 `autoReply` / `autoDecisionHints` |
| `apps/console/app/api/tasks/route.ts` | POST 接收 + 转 createTask |
| `apps/console/app/api/tasks/[id]/route.ts` | PATCH 接收 + 转 updateTask |
| `README.md` | 新增"任务自动回复（无人值守闭环）"段 |
| `docs/acceptance/task-auto-reply/scripts/verify-auto-reply.mts` | 字段端到端 round-trip 烟测脚本 |

## 验证（worktree 内）

1. `npm run typecheck` —— 五包全绿
2. `npm run build` —— 五包构建（含 next build）通过
3. `node scripts/ephemeral-db.mjs --verify` —— 21 个迁移在一次性干净库应用成功 + verify:console 401→200
4. `npx tsx docs/acceptance/task-auto-reply/scripts/verify-auto-reply.mts` —— 字段端到端 round-trip：
   - createTask 写 `auto_reply=true` + hints → `RETURNING *` 拿回一致值
   - updateTask 切回 false / 空 hints → 写回正确
   - 旧 INSERT 不带新列 → 默认 `false` / `''`，存量任务零破坏

未覆盖：真 Claude CLI 跑 auto_reply 模式的端到端（需 Worker 真启动 + 真 Anthropic 凭据），靠 prompt review + 单元字段 round-trip 兜底；上线后用真任务验证主防线/兜底效果。
