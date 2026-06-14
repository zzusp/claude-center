# 实时直连对话（Worker Direct Chat）

> 把"问答"从任务流里彻底拆出来：独立菜单、独立数据模型、独立实时传输（SSE 流式 token），指定**项目（分支）+ 指定 worker** 直接对话。

## 1. 背景与目标

现状里「问答」是 `task_type='qa'`（迁移 `005_task_types.sql`），它的实现恰恰是要被推翻的形态：

- 走同一套任务流：同 `POST /api/tasks` 创建 → 进 pending 队列 → `claimNextTask()`（`packages/db/src/queries.ts:594`）认领；执行时只在 `apps/worker/src/executor.ts:441` 按 `task_type` 分叉跳过 git。
- 同一个菜单、同一套传输：在「任务调度」列表里混排（`apps/console/app/ui/tasks.tsx:220`、`overview.tsx:156`），前端 3s 全量轮询（`apps/console/app/lib/use-polling.ts:6`）。
- **不能指定 worker**：进项目 pending 队列，哪个关联该项目的 worker 抢到算哪个。

**已锁定的设计决定**（用户拍板）：

1. **实时传输**：SSE 流式 token（打字机效果）——worker 流式上报 claude stdout 分片，浏览器逐字显示。
2. **执行环境**：指定分支检出上**只读对话，不碰 git**（不 commit / 不开 PR）。
3. **旧 qa（范围外）**：已有独立未合并分支 `worktree-remove-qa-task-type` 负责彻底铲除 qa（删 `task_type` 列 + worker qa 分支，已占迁移 016）。**本特性纯新增、不碰 qa**——不动任务表单 / `executor.ts` qa 分叉 / `task_type`，新迁移从 **017** 起，与那条 PR 触碰文件零重叠、各自独立合入。

**目标**：在不破坏现有任务流的前提下，新增一条端到端的实时对话通道——选项目→选分支→选 worker→多轮对话，助手回复逐字流式呈现。

## 2. 范围边界（不碰 qa）

「下线 qa」由并行分支 `worktree-remove-qa-task-type`（main 之上 1 commit、未合，已占迁移 016）**独立负责，不在本特性范围**。本分支纯新增：新菜单 + 新表 + 新 SSE 通道，**完全不修改** `tasks.task_type` / 任务创建表单 / `executor.ts` 的 qa 分叉。两条 PR 触碰文件零重叠、各自独立合入；新对话与历史 qa 在产品上并存一段时间不冲突（qa 的最终去留由那条分支决定）。

## 3. 数据模型（新迁移 `017_conversations.sql`）

> 迁移号 **017**：main 到 015，`worktree-remove-qa-task-type` 已占 016（未合），017 经全分支扫描（`git log --all --diff-filter=A -- packages/db/migrations/`）未被占用。

### 3.1 `conversations`（一次对话会话）

```sql
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id  uuid NOT NULL REFERENCES workers(id)  ON DELETE CASCADE,  -- 定向的具体 worker
  branch     text NOT NULL,                                            -- 对话针对的分支（只读检出）
  title      text NOT NULL DEFAULT '',                                 -- 首条消息自动生成 / 用户可改
  model      text NOT NULL DEFAULT 'default'
             CHECK (model IN ('default','opus','sonnet','haiku')),     -- 复用 tasks.model 语义
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','closed')),
  claude_session_id text,                                              -- 续接 --resume
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_worker_active_idx ON conversations(worker_id, status, updated_at DESC);
CREATE INDEX conversations_project_idx       ON conversations(project_id, updated_at DESC);
```

### 3.2 `conversation_messages`（消息流）

```sql
CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq  bigint NOT NULL,                          -- 会话内单调递增，排序 + 派发判定
  role text NOT NULL CHECK (role IN ('user','assistant')),
  body text NOT NULL DEFAULT '',                 -- user: 提问全文；assistant: 完成后落最终全文
  status text NOT NULL DEFAULT 'done'
         CHECK (status IN ('pending','streaming','done','failed')),
  -- user 消息 status 恒 'done'；assistant 消息：claimed→'streaming'→'done'/'failed'
  claimed_by uuid REFERENCES workers(id) ON DELETE SET NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id, seq)
);
CREATE INDEX conversation_messages_conv_idx ON conversation_messages(conversation_id, seq);
```

### 3.3 `conversation_message_chunks`（流式分片，append-only）

```sql
CREATE TABLE conversation_message_chunks (
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  seq   integer NOT NULL,                         -- 该消息内分片序号，从 0 递增
  delta text NOT NULL,                            -- 本片新增文本
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, seq)
);
```

> 分片与最终全文双写：流式期间只写 chunks；turn 收尾时把拼好的全文写回 `conversation_messages.body` 并置 `status='done'`。**断线重连**靠 SSE `Last-Event-ID = chunk seq` 从 chunks 续传；历史消息直接读 `body`，不必回放 chunks。

## 4. 派发与执行（Worker）

照搬 `direct_commands` 的"按 worker_id 领专属队列"模式（`runner.ts:493` → `claimNextDirectCommand`）。

### 4.1 认领（新查询 `claimNextConversationTurn`）

在 worker tick（`runner.ts` 现有 task / resumable / rejected / directCommand 之外）新增一支：

```
SELECT 出一个会话：其 worker_id = $1、status='active'，
且最后一条消息 role='user'（即有未答的用户轮），
且不存在该轮之后 status IN ('pending','streaming') 的 assistant 消息（防重复领）。
认领动作 = 插入一条 assistant 消息 (status='streaming', claimed_by=$1, seq=下一个)，
单事务里完成判定 + 插入，避免并发重复应答。
```

- **不阻塞任务流**：对话轮的认领独立于 `claimNextTask` 的 work-state / worktree 门控，长期开着的对话不冻结项目任务流转（与现 qa 设计意图一致，`docs/spec/task-types.md:40` 同理）。

### 4.2 执行（`executeConversationTurn(config, conv, asstMsg)`）

1. 经 `worker_project_links` 解析 `conv.project_id` 的 `local_path`（复用 `getTaskLocalPath` 同源逻辑）。
2. **只读分支检出**：`git -C <localPath> fetch origin`，在**每会话独立的只读 worktree**（`worktreePathForConversation(config, conv.id)`，检出到 `origin/<conv.branch>`，detached）里跑——不碰主检出、不碰用户工作树、全程不 commit。会话 `close` 时移除该 worktree。
3. 调 claude **流式**形态（见 §5.1）：`spawnClaude(config, { full:false, prompt, cwd:wtPath, resumeSessionId: conv.claude_session_id, model: conv.model, onSpawn })`，`onSpawn` 拿到 child 后挂 `child.stdout` 增量解析 NDJSON。
4. 每解析出一段 assistant 文本增量 → `appendConversationChunk(messageId, seq++, delta)` + `NOTIFY cc_conversation, '<convId>:<messageId>:<seq>'`。
5. 收尾：拼全文写回 `body`、`status='done'`、把 `system.session_id` 存入 `conversations.claude_session_id`（首轮）、`updated_at=now()`。出错置 `status='failed'` + `error_message`，并 NOTIFY 一个终止事件。**失败轮为终态、不自动重试**（避免持久失败死循环）：`getConversationPrompt` 把 `failed` 也视为"该问已闭合"，用户**再发一条消息**才触发重答（已由 P0 验收覆盖）。

### 4.3 对话并发车道（待确认，见 §9）

对话轮**默认不占任务 `max_parallel` 槽位**，单独限流（建议每 worker 同时 ≤1 个对话轮在途），让对话在 worker 跑任务时仍可响应。

## 5. 实时传输（SSE 流式）— 核心

链路：**claude stdout（NDJSON）→ worker 增量解析 → PG chunks + NOTIFY → console SSE 端点 LISTEN 转发 → 浏览器 EventSource 逐字渲染**。

### 5.1 Worker 侧：换流式输出格式

现 `spawnClaude` 用 `--output-format json`（executor.ts:93）整段缓冲。新增**流式调用形态**：`--output-format stream-json --verbose --include-partial-messages`。

**已真跑校验（claude 2.1.177，证据 `docs/acceptance/worker-direct-chat/round-1.md`）的 NDJSON 事件 schema**：

- **token 增量**：`type:"stream_event"` + `event.type:"content_block_delta"` + `event.delta.type:"text_delta"` → 取 `event.delta.text`。增量为**块级**（几个 token 一批、非严格逐字），仍呈打字机感。
- **会话 id + 终态**：末行 `type:"result"` + `subtype:"success"`，带 `session_id` 与 `result`（完整全文，作 finalize `body` 的权威来源）。
- **须容错跳过**：`system`(init/status) / `message_start` / `content_block_start|stop` / `message_delta` / `message_stop` / `rate_limit_event` 等忽略；**非 JSON 行也要跳过**（stderr 的 "no stdin data" 警告可能混入）。

解析：`onSpawn(child)` 拿 `child.stdout`，按 `\n` 缓冲分行、逐行 `try JSON.parse`，命中 text_delta 即 `appendConversationChunk` + NOTIFY；`runCommand` 仍 resolve 完整 `CommandResult` 兜底退出码 / stderr。

### 5.2 Console 侧：SSE 端点 + 单连接 LISTEN 扇出

- 进程内维持**一个**专用 pg client `LISTEN cc_conversation`（不占连接池），收到 NOTIFY 后经进程内 EventEmitter 按 `conversationId` 扇出给本实例所有在连的 SSE response。
- `GET /api/conversations/[id]/stream`（route handler 返回 `ReadableStream`，`Content-Type: text/event-stream`）：
  - 连接时先把该会话**未发送完的 assistant 消息**已有 chunks（`> Last-Event-ID`）补发，再订阅后续 NOTIFY。
  - 每个 SSE event：`id: <chunk seq>` + `data: {messageId, delta}`；turn 结束发 `event: done`（带最终 body / session 信息）。
  - 兜底**慢轮询**（如每 2s 查一次该会话有无遗漏 chunk），防 NOTIFY 偶发丢失。
- **跨实例安全**：每个 console 实例都 LISTEN，只转发给自己连着的浏览器；worker 的 NOTIFY 广播到所有实例。

### 5.3 历史消息

会话详情 `GET /api/conversations/[id]` 直接返回 `conversation_messages`（含 `body`），前端首屏渲染历史；只有"正在流式的 assistant 消息"走 SSE。

## 6. Console UI / 菜单 / API

### 6.1 菜单

`apps/console/app/ui/dashboard.tsx:155` 的 `navItems` 增一项 `{ key:'chat', label:'对话', icon:<MessageSquare/> }`，`pageMeta`（:163）加对应标题；视图路由（:230）加 `view==='chat' → <ChatView/>`。

### 6.2 新视图 `apps/console/app/ui/chat.tsx`

- **左栏**：对话列表（按 worker / 项目分组，显示标题、最后活跃时间、状态）。顶部「新建对话」：选项目 → 选分支（复用 `GET /api/projects/[id]/branches`）→ 选 worker（**仅在线且关联该项目**的 worker）→ 选模型 → 创建。
- **右栏**：消息线 + 输入框。打开会话即建 `EventSource('/api/conversations/[id]/stream')`；发消息 `POST .../messages`；assistant 消息逐字追加；「结束对话」`POST .../close`。
- UI 原子复用 `apps/console/app/ui/shared.tsx`（StatusBadge / fmtDateTime / Tone 等），不另写。

### 6.3 API 路由（`apps/console/app/api/conversations/`）

| 路由 | 方法 | 作用 |
|------|------|------|
| `/api/conversations` | `POST` | 建会话 `{projectId, branch, workerId, model}` |
| `/api/conversations` | `GET`  | 列会话（按 RBAC 项目可见性过滤） |
| `/api/conversations/[id]` | `GET` | 会话 + 历史消息 |
| `/api/conversations/[id]/messages` | `POST` | 发用户消息（插 `role='user'` 触发 worker） |
| `/api/conversations/[id]/stream` | `GET` | SSE 流式 assistant token |
| `/api/conversations/[id]/close` | `POST` | 结束会话（status='closed' + 清 worktree 信号） |

### 6.4 DB 查询（`packages/db/src/queries.ts` + `types.ts`）

新增：`createConversation` / `listConversations` / `getConversation(+messages)` / `addConversationMessage` / `claimNextConversationTurn` / `appendConversationChunk` / `finalizeConversationTurn` / `closeConversation`；`types.ts` 加 `Conversation` / `ConversationMessage` / `ConversationChunk` 类型。

## 7. 执行环境 / 分支 / 只读保证

- 对话在 `origin/<branch>` 的**独立只读 worktree**里跑，全程无 `git add/commit/push`、无 PR——与任务执行（建工作分支、finalize commit/PR）彻底分开。
- worktree 复用同一会话的多轮；`close` 时 `removeWorktree`。
- claude 调用用直接 spawn + 跟随 claude 默认安全姿态（不挂 `--permission-mode` / `--settings` / `--append-system-prompt-file`，等同现 `direct_commands` 的 `claude_prompt` 语义）——避免对话被赋予任务级写权限。
- **流式用直接 spawn**（`--output-format stream-json`），**不走 worker 的「终端 / 前置命令」形态**（终端包裹会污染 NDJSON）。因此对话所需的**代理 / 环境变量须在 worker 进程 env**（如 `HTTP_PROXY` / `HTTPS_PROXY`），而非仅靠桌面端「前置命令」——已由 P1 端到端验证（`docs/acceptance/worker-direct-chat/round-2.md`）。

## 8. 权限（RBAC）

- 创建/发消息：复用现有权限位（倾向 `command.create`——与"定向 worker 下指令"同级能力；`packages/db/src/rbac.ts`）。
- 列表/查看：按 `user_project_links` 项目白名单过滤（非 admin 仅见自己有权项目的会话），与现有任务列表过滤一致。
- 具体权限位实施时定，先按 `command.create`（写）+ 项目可见性（读）落地。

## 9. 待确认 / 盲点（实施前需定，给了推荐默认值不阻塞）

1. **对话并发车道**：对话轮是否占 `max_parallel` 任务槽？推荐**独立车道、每 worker ≤1 在途**，保证忙时仍可聊。
2. **是否受 working_state 门控**：worker `idle` 时是否仍应答对话？推荐**应答**（用户显式点名了这个 worker）；但若要求"停工即静默"则需门控。
3. **权限位**：复用 `command.create` 还是新增 `conversation.create`？推荐先复用。
4. **迁移编号**：实施时 `git fetch` 取未占用编号 + status/约束列全集（`CLAUDE.md` 迁移规范）。
5. **stream-json 事件 schema**：claude CLI 实际字段名先真跑验证（§5.1）。
6. **超时与取消**：对话轮复用 `CLAUDE_TIMEOUT_MS`？是否要"停止生成"按钮（→ 杀 child + 置 failed）？推荐 v1 先不做取消按钮。

## 10. 实施阶段（每阶段可独立验证，留检查点）

- **P0 数据层**：迁移 + queries + types；对临时库 `db:ephemeral` 跑通 schema、CRUD round-trip。
- **P1 worker 流式**：`stream-json` 真跑校验事件 schema → 增量解析 → chunks 落库 + NOTIFY；后台脚本 seed 一条会话 + 用户消息，驱动 worker boot 跑一轮，断言 chunks/最终 body/session_id。
- **P2 console SSE**：SSE 端点 + LISTEN 扇出；脚本对端点发起 EventSource 断言收到分片与 `done`。
- **P3 console UI**：chat 视图 + 新建/发送/流式渲染/结束；`verify:console` 绿 + 手动跑一轮对话看打字机效果。

## 11. 涉及文件清单（预估）

- `packages/db/migrations/0NN_conversations.sql`（新）
- `packages/db/src/{queries.ts,types.ts}`（增）
- `apps/worker/src/{executor.ts,runner.ts}`（增流式调用 + 认领支 + executeConversationTurn）
- `apps/console/app/api/conversations/**`（新，6 个 route）
- `apps/console/app/ui/{dashboard.tsx,chat.tsx,shared.tsx}`（增菜单 + 新视图）
- `apps/console/instrumentation.ts` 或新 lib（console 进程的 LISTEN 单连接）
- `README.md` / `docs/spec/task-types.md`（同步行为变更）

## 12. 验证计划（acceptance）

落 `docs/acceptance/worker-direct-chat/`：`plan.md` + `matrix.csv`（用例×round）+ `round-N.md`。关键用例：建会话→发消息→收到流式 token→多轮 `--resume` 续接→结束会话清 worktree→并发两会话指向同 worker→断线重连续传→只读保证（对话不产生任何 git 改动）→旧 qa 历史仍可读、新建入口已下线。
