# 验收：实时直连对话（Worker Direct Chat）

## 需求

把"问答"从任务流拆出来：独立菜单 + 独立数据模型 + 独立实时传输（SSE 流式 token），指定**项目(分支) + 指定 worker** 直接多轮对话。设计见 `docs/spec/worker-direct-chat.md`。

锁定决定：① SSE 流式 token；② 指定分支检出上只读对话、不碰 git；③ 纯新增、不碰 qa（删 qa 由并行分支 `worktree-remove-qa-task-type` 负责，已占迁移 016，本特性用 017）。

## 改动（分阶段）

- **P0 数据层**：迁移 `017_conversations.sql`（`conversations` / `conversation_messages` / `conversation_message_chunks`）+ `packages/db/src/types.ts` 三类型 + `packages/db/src/queries.ts` 12 个查询函数。
- **P1 worker 流式**：`claude --output-format stream-json` 增量解析 → chunks 落库 + NOTIFY；`runner.ts` 新认领支 + `executor.ts` `executeConversationTurn`。
- **P2 console SSE**：`/api/conversations/[id]/stream` + 进程内单连接 LISTEN 扇出。
- **P3 console UI**：`chat.tsx` 视图 + 菜单项 + 新建/发送/流式渲染/结束。

## 关键设计语义（验收锁定）

- **认领**：本 worker 的 active 会话、最后一条是 user 消息、且无在途 assistant 轮 → 原子插入 assistant `streaming` 消息（`FOR UPDATE SKIP LOCKED` 防并发重复应答）。
- **本轮提问**：取"最后一条已完成（done/failed）assistant 之后"的全部 user 消息按 seq 拼接（多条连发合并为一轮）。
- **失败轮终态**：assistant 失败不自动重试；用户再发一条消息才触发重答。
- **RBAC**：`listConversations(projectIds)` 按项目白名单过滤；admin 传 `null` 看全部。

## 验证

- P0：对一次性干净库跑全量迁移链 + 全套查询函数往返断言，零污染共享库。脚本 `scripts/verify-data-layer.mts`，证据见 `round-1.md`。状态以 `matrix.csv` 为准。
