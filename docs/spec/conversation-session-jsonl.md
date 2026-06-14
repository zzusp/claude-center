# 对话存完整 session jsonl + 富展示（参考 claude-code-session）

> 需求来源：用户原话「对话要存完整的 jsonl，和任务存储一样，对话记录不自动删除清理。对话页面的展示要参考 D:\project\claude-code-session 项目的 session 内容的展示」。
> 决策（已与用户确认）：① 实时反馈机制选「统一 jsonl 轮询」——去掉 SSE/chunks，对话像任务那样周期轮询 jsonl 刷新富展示；② 展示选「完整移植 + 共用」——完整复刻 claude-code-session 风格，并把任务详情现有简化 transcript 一起升级、共用同一套渲染组件。

## 1. 现状（改造前）

| 维度 | 任务（task） | 对话（conversation） |
| --- | --- | --- |
| claude 调用 | `runClaudeJson`（`claude -p ... --output-format json`，非流式），`executor.ts:150` | `streamClaude`（`--output-format stream-json --include-partial-messages`），`executor.ts:199` |
| session jsonl | ✅ Worker 周期(20s)+终态强制从 `~/.claude/projects/<encode(cwd)>/<sessionId>.jsonl` 读全文 → `task_sessions` 侧表（`session.ts:61` `startTaskSessionSync`、migration 018） | ❌ 不存。assistant 回复只从 `text_delta` 抽纯文本，tool_use/tool_result/thinking 全丢弃 |
| 实时通道 | Console 按需轮询 `GET /api/tasks/[id]/session` | SSE `GET /api/conversations/[id]/stream` + `conversation_message_chunks`（增量分片）+ `pg_notify('cc_conversation')` |
| 富展示 | `task-detail.tsx:567` `SessionTranscript`——**简化版**：`parseTranscript` 解析 NDJSON → text/thinking/tool_use/tool_result，渲染为纯文本 `<pre>`，无折叠/diff/markdown/文件卡 | `chat.tsx:320` `Bubble`——纯文本气泡 + 打字机光标 |
| 自动清理 | 无 TTL、无定时清理，仅 project/task 删除时 `ON DELETE CASCADE` | 同左，无自动清理 |

参考项目 `D:\project\claude-code-session`（React19+Vite+Hono 独立站）可移植的是「jsonl → Block[] 解析 + 富渲染」：`MessageBubble` / `ToolBlock`（工具折叠、unified diff 着色、文件卡、bash/todo）/ `ThinkingBlock` / `MarkdownContent`（react-markdown + remark-gfm）。技术栈与本仓 Next.js 不同，**移植渲染逻辑、不搬组件文件**。

## 2. 目标

1. 对话执行时把 Claude Code session `.jsonl` 全文同步落库，与任务 `task_sessions` 同构（新 `conversation_sessions` 侧表）。
2. 对话记录不自动删除（现状本就无清理，确认 + 一致性：仅级联删）。
3. 对话页消息线改为 jsonl 富展示，渲染逻辑升级到 claude-code-session 风格，**与任务详情共用同一套 transcript 组件**。
4. 去掉对话的 SSE/chunks 流式那一套（统一为 jsonl 周期轮询）。

## 3. 方案与改动清单

### 3.1 数据层（packages/db）

- **migration `019_conversation_session_jsonl.sql`**（编号已核：origin/main 与全部 worktree ref 历史最大 018，019 未占用）：
  - `CREATE TABLE conversation_sessions (conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, jsonl text NOT NULL, synced_at timestamptz NOT NULL DEFAULT now())`。
  - `DROP TABLE IF EXISTS conversation_message_chunks`（统一 jsonl 后弃用流式分片表）。
- **queries.ts**：新增 `upsertConversationSession` / `getConversationSession`（仿 `upsertTaskSession`/`getTaskSession` 1007-1030）；删 `appendConversationChunk`(1638)、`getConversationChunks`(1649)、`notifyConversationChunk`(1715)、`getLatestAssistantMessage`(1723，仅 SSE 端点用)。`finalizeConversationTurn`/`failConversationTurn` 保留（body 仍存最终全文，供列表预览/降级）。
- **types.ts**：删 `ConversationChunk`(237)。
- **notify.ts**：整文件删（只服务对话 SSE 的 `LISTEN cc_conversation` 跨实例扇出）。**index.ts** 删 line 4 的 `onConversationNotice`/`ConversationNotice` 导出。

### 3.2 Worker（apps/worker）

- **session.ts**：抽私有 `startSync(cwd, persist)`（周期 20s + 返回 stop() 强制终态同步，逻辑同现 `startTaskSessionSync`）；`startTaskSessionSync` 与新增 `startConversationSessionSync(conversationId, cwd)` 都是其薄封装。
- **executor.ts**：删 `streamClaude`(199-270)。`executeConversationTurn`(726) 改写：`const stop = startConversationSessionSync(conv.id, wtPath)`；用 `runClaudeJson`（替 streamClaude）跑 claude（带 `--resume`/`model`）；`finally` `await stop()`；收尾 `finalizeConversationTurn(body: result, sessionId)`，catch `failConversationTurn`。删 chunk/notify 相关 import 与调用。
- **runner.ts**：删 `getConversationChunks` import(13)；`getConversationDetail`(380) 去掉 chunks 拼装，直接 `return { messages }`（桌面端回显降级：完成后见全文 body，流式中 body 空 → 桌面端显示状态。范围控制，不在本轮做 worker 端富展示）。

### 3.3 Console API（apps/console/app/api）

- 删 `conversations/[id]/stream/route.ts`（SSE 端点）。
- 新增 `conversations/[id]/session/route.ts`：仿 `tasks/[id]/session/route.ts`，返回 `{ jsonl, syncedAt }`；非 admin 用 `getConversation` 取 `project_id` 校验 `userHasProject`。

### 3.4 Console UI（apps/console/app/ui）

- **新文件 `transcript.tsx`**（共用富渲染）：从 task-detail 抽出 `parseTranscript` + 升级版渲染组件 `TranscriptView`，覆盖：
  - 用户/assistant 消息分行；assistant text → markdown（react-markdown + remark-gfm）。
  - `tool_use` 折叠头（工具名 + 参数摘要）+ 展开体；Edit/Write → unified diff 着色；Bash/PowerShell → 命令块；其它 → JSON `<pre>`。
  - `tool_result` 成功/失败着色、长输出折叠。
  - `thinking` 折叠块。
- **task-detail.tsx**：`SessionTranscript` 保留轮询逻辑，渲染改调共用 `TranscriptView`，删本地 `TranscriptBlock*`/`parseTranscript`。
- **chat.tsx**：`ChatThread` 删 SSE/streaming/`Bubble`；改为轮询 `GET /api/conversations/[id]/session`（active 且 generating/最后是 user 时 5s 轮询，否则取够即停），`parseTranscript(jsonl)` → `<TranscriptView>`。保留发消息/改名/结束/新建面板。jsonl 未出现该轮时用本地乐观 user 气泡 + 「回复中」兜底。
- **globals.css**：新增富展示样式（工具折叠/diff/markdown/thinking），复用现有 `--color-*` token。
- **apps/console/package.json**：加 `react-markdown` + `remark-gfm`（纯 client 组件，"use client" 下用）。

## 4. 验证计划（顺序固定，CLAUDE.md 本地验证）

1. `npm run typecheck`（db/console/worker 三包绿）。
2. `node scripts/ephemeral-db.mjs --check`（零副作用自检）→ `npm run db:ephemeral`（干净库跑全量迁移含 019 + DROP chunks）。
3. `npm run build`（含 next build，验 react-markdown 兼容）。
4. `node scripts/ephemeral-db.mjs --verify`（临时库 + verify:console 401→200）。
5. worker 侧：headless 脚本对临时库 seed 一个 conversation → 跑 `executeConversationTurn`（真/桩 claude）→ 断言 `conversation_sessions.jsonl` 落库且解析出 blocks；或最低限度断言 `startConversationSessionSync` round-trip。
6. 文档同步：README「对话」段（239-246）改写为 jsonl 轮询；本 spec 收口。

## 5. 范围与取舍

- **桌面端 worker「对话」面板**：本轮仅保证不破（回显降级为 body + 状态），不做 worker 端富展示——用户需求聚焦 web 对话页。
- **DROP conversation_message_chunks**：破坏性，但统一 jsonl 后该表无用；共享 dev 库不主动迁移，迁移仅在 ephemeral 干净库验证（CLAUDE.md「别拿共享库验证迁移」）。
- **逐字打字机消失**：改为整块轮询刷新（~3s），与任务/claude-code-session live tail 一致；换来 tool_use/thinking 等富内容可见。
</invoke>
