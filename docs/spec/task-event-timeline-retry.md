# 细颗粒度任务事件时间线 + 失败节点续接重试

> 状态:方案待 review（开工前快照，不回头维护）
> 范围:`packages/db`(事件落点) + `apps/worker`(执行埋点 + 重试执行器) + `apps/console`(时间线 UI + 重试入口)
> 关联:[task-acceptance-dependencies](./task-acceptance-dependencies.md)(打回重跑机制)、[task-list-and-detail-refactor](./task-list-and-detail-refactor.md)(详情页拆分 + 聚合轮询)、[task-comment-confirm](./task-comment-confirm.md)(waiting/续接)

## 1. 背景与目标

任务详情「时间线」Tab 当前有两层(`apps/console/app/ui/task-detail-timeline.tsx:8-54`):

1. **执行阶段条(lifecycle bar)** — 5 个写死节点,数据来自 `task` 表 4 个时间戳。粒度太粗。
2. **事件流(timeline)** — 列 `task_events` 表记录。粒度本应更细,但实际有「断点」:很多关键生命周期转换根本没落事件,且前端只翻译了 6 种事件类型。

**目标**(已与需求方确认):

- **G1 — 补全事件,下探到执行子步骤**:从「认领」到「人工验收」的每个生命周期节点都要有事件;并把 Worker 执行编排的关键子步骤(工作树准备、恢复执行、提交、推送、建 PR、自动合并…)也纳入时间线。Claude 内部逐轮对话/工具调用不在本时间线重复(已有「Claude Code 执行」Tab 的 transcript 承载),时间线节点提供跳转。
- **G2 — 失败节点可续接重试**:在失败事件节点上提供「重试」,语义为**续接重跑**(复用现有打回重跑 `rerunRejectedTask` 的机制:保留 Claude session 上下文,把失败原因作为新一轮输入),而非清空回草稿重来。

## 2. 现状(带证据)

### 2.1 时间线两层结构与数据流

- 时间线 Tab:`task-detail-timeline.tsx:8-54`(执行阶段条 + 事件流两个 `Section`)。
- lifecycle 5 节点写死:`apps/console/app/ui/task-detail.tsx:161-186`(已创建/已认领/开始执行/完成·失败·取消/人工验收),`time` 取自 `task.created_at|claimed_at|started_at|finished_at`。
- 事件流数据:聚合端点 `GET /api/tasks/[id]`(`apps/console/app/api/tasks/[id]/route.ts:50-55`)一次返回 `{task, predecessors, events}`,`events` 来自 `listTaskEvents`(`packages/db/src/queries.ts:592-598`,按 `created_at ASC`)。
- 轮询:详情页 3s 常驻轮询该聚合端点 + SSE 快线触发额外刷新(`task-detail.tsx:44-75`,`apps/console/app/lib/use-polling.ts`)。
- 事件标签字典只覆盖 6 种:`EVENT_LABEL`(`apps/console/app/ui/task-detail-shared.tsx:19-26`)= running/success/merged/failed/waiting/scheduled_published;其余 `event_type` 直接以英文原样显示(`task-detail-timeline.tsx:40`)。

### 2.2 状态机全集(无需新增状态)

12 个状态,定义出处 `packages/db/src/task-state.ts`,约束 `tasks_status_check` 最后一次重建在 `migrations/009_task_scheduled.sql`:

```
draft → (publish) → pending          scheduled → (到点) → pending
pending → (claim) → claimed → (markRunning) → running
running → waiting → (用户回复) → running           （问答续接）
running → success                                   （执行完成待验收）
running → failed / cancelled                        （失败 / 取消终态）
success → accepted（人工/自动验收）| merged（push 直推 / PR 合并清理）
success → rejected → (打回重跑) → running           （验收驳回续接）
failed / cancelled → (reactivate) → draft           （清空回草稿）
```

`running` 自 `001` 起合法,**失败重试是 `failed → running`,不引入新状态**。

### 2.3 事件全集:已有 vs 缺失

`task_events.event_type` 是 `text NOT NULL` **无 CHECK 约束**(`migrations/001_init.sql:72-80`),新增事件类型零迁移。

**当前已落事件**(出处):

| event_type | 触发 | 出处 | worker_id |
|---|---|---|---|
| `scheduled_published` | 定时到点转 pending | `queries.ts:305` | null |
| `running` | markTaskRunning(**仅新任务**) | `queries.ts:939` | worker |
| `waiting` | 默认分支转等待 | `executor.ts:370` | worker |
| `auto_reply` | 无人值守自动回复第 N 轮 | `executor.ts:356` | worker |
| `auto_reply_blocked` | 自动回复兜底失败 | `executor.ts:339,351` | worker |
| `committed` | 工作分支提交 | `executor.ts:404` | worker |
| `pushed` | 推送分支(push/PR 模式) | `executor.ts:414,434` | worker |
| `pr_created` | 创建 PR | `executor.ts:468` | worker |
| `auto_merged` / `auto_merge_failed` | PR 自动合并成/败 | `executor.ts:483,489` | worker |
| `success` | 执行完成 | `queries.ts:960` | worker |
| `failed` | 执行失败 | `queries.ts:983` | worker |
| `cancel_requested` | 用户请求取消 | `queries.ts:1003` | null/claimed_by |
| `cancelled` | Worker 完成取消 | `queries.ts:1040` | worker |
| `accepted` / `rejected` | 人工验收通过/打回 | `queries.ts:1059,1085` | null |
| `merge_accepted` | 检测合并自动验收 | `queries.ts:1186` | null |
| `merged` | 合并清理终态 | `queries.ts:1107` | worker |
| `cleanup_retry` | 合并清理出错重试 | `executor.ts:687` | worker |

**缺失(断点)**——这些转换直接 UPDATE status,不落事件:

| 缺失节点 | 现状出处 | 说明 |
|---|---|---|
| `published` | `publishTask`(`queries.ts:264`) | draft/scheduled→pending 无事件 |
| `claimed` | `claimNextTask`(`queries.ts:873`) | pending→claimed 无事件(lifecycle 条靠 `claimed_at` 补) |
| 续接执行(`resumed`) | `claimNextResumableTask`(`queries.ts:1203`)→`resumeTask`(`executor.ts:550`) | waiting→running **不调 markTaskRunning,无任何事件** |
| 打回重跑(`rerun_started`) | `claimNextRejectedTask`(`queries.ts:1241`)→`rerunRejectedTask`(`executor.ts:594`) | rejected→running **不调 markTaskRunning,无任何事件** |
| 工作树准备 | `ensureWorktree`(`executor.ts:526,573,615`) | 无事件 |

### 2.4 三条执行入口的子步骤(下探依据)

- **新任务 `executeTask`**(`executor.ts:511-547`):`markTaskRunning`(落 running)→ `git fetch origin`(525)→ `ensureWorktree` fresh(526)→ `runTaskClaude`(532)→ `handleClaudeTurn`(538)→ catch 落 `failed` + 删工作树(540-545)。
- **续接 `resumeTask`**(`executor.ts:550-590`):`getPendingReply`→ `ensureWorktree` 复用(573)→ `runTaskClaude` resume(574)→ `handleClaudeTurn`。**全程无 running 类事件**。
- **打回重跑 `rerunRejectedTask`**(`executor.ts:594-633`):`getPendingReply`(feedback)→ `git fetch`→ `ensureWorktree` 复用(615)→ `runTaskClaude` resume(617)→ `handleClaudeTurn`。**全程无 running 类事件**。
- 收尾 `finalizeTask`(`executor.ts:379-508`):`git status`→ 无改动直接 success;有改动 `add`+`commit`(落 committed)→ push 模式直推+`merged`,PR 模式 push+(复用 PR 或 `gh pr create`+可选 auto-merge)+`success`。
- 调度优先级 `claimAndStartOne`(`runner.ts:774-829`):直接指令 → 续接(resumable)→ 打回(rejected)→ 新任务 → 合并清理(cleanup)。

### 2.5 失败与重试现状

- 失败一律 `markTaskFailed`(`queries.ts:963-984`):SET status=failed/finished_at/error_message/result,**不清 `claimed_by`**(机器锁定保留)。三处 catch + 两处 auto_reply 兜底调用(`executor.ts:540,583,626,332,344`)。
- 失败后工作树被 `removeWorktree` 删除(`executor.ts:544,587,630`)。
- 现有唯一恢复路径:`reactivateTask`(`queries.ts:236-263`)→ 清空所有运行态字段(`TASK_RUNTIME_FIELDS`,`task-state.ts:48-62`,含 `claimed_by`/`claude_session_id`)→ 回 draft,需重新发布+认领,**丢弃全部上下文**。
- **打回重跑已是「续接重跑」范本**:`claimNextRejectedTask` 按 `claimed_by` 机器锁定认领 rejected → `rerunRejectedTask` 用 `task.claude_session_id` resume + `getPendingReply` 取打回意见作为 prompt,`finalizeTask` 因 `pr_url` 已存在复用原 PR(`executor.ts:440-449`)。失败重试将复刻这一模式。

## 3. 设计:细颗粒度事件时间线(G1)

### 3.1 边界:时间线 vs 执行 Tab

- **时间线 = 任务生命周期 + Worker 执行编排子步骤**(状态转换 + 工作树/git/PR 里程碑)。
- **Claude 内部逐轮对话 / 工具调用 / thinking = 已有「Claude Code 执行」Tab**(`task-detail-session.tsx`,数据为 `task_sessions` 同步的 session jsonl,见 [conversation-session-jsonl](./conversation-session-jsonl.md) 同源机制)。时间线**不重复**这层,在「开始执行/恢复执行」节点提供「查看执行详情 →」跳转到执行 Tab。

理由:逐轮 transcript 已被完整同步与富展示,再塞进时间线会重复且爆量;时间线聚焦「编排发生了什么」,transcript 聚焦「Claude 具体做了什么」。

### 3.2 目标态事件全集

在 2.3 已有事件之上,**新增/补全**:

| event_type | 中文标签 | 落点 | 必做? |
|---|---|---|---|
| `published` | 发布 · 进入待处理 | `publishTask` + `promoteDueScheduledTasks`(后者已有 `scheduled_published`,保留) | 必做 |
| `claimed` | 已认领 | `claimNextTask` 成功后 | 必做 |
| `resumed` | 用户回复 · 续接执行 | `resumeTask` 跑 Claude 前 | 必做(补断点) |
| `rerun_started` | 打回 · 续接重跑 | `rerunRejectedTask` 跑 Claude 前 | 必做(补断点) |
| `retry_started` | 失败 · 续接重试 | `retryFailedTask`(新增,见 §4) 跑 Claude 前 | 必做(G2) |
| `worktree_prepared` | 工作树就绪 | 四条入口 `ensureWorktree` 后 | 可选增强 |
| `claude_turn_finished` | 本轮执行结束 | `runTaskClaude` 返回后(payload 带结果摘要/是否命中哨兵) | 可选增强 |

「开始执行」语义已由 `running`(新任务)+ `resumed`/`rerun_started`/`retry_started`(三种恢复)覆盖,**不再单造 `claude_turn_started`**,避免与上述重复(原则:一条清晰路径,不过度埋点)。

**轮次(attempt)概念**:`running`/`resumed`/`rerun_started`/`retry_started` 这组「执行起点」事件天然把时间线切成多轮。同一任务多次失败重试 / 打回重跑会形成多组「起点 … 终点(success/failed/waiting)」序列,前端据此分组(§3.4)。

### 3.3 补事件的落点

原则:**事件与状态变更同事务/同函数落库**(对齐既有 `addTaskEvent` 在状态函数内调用的模式,如 `markTaskRunning`/`acceptTask`)。

- `published`:在 `publishTask`(`queries.ts:264`)成功 UPDATE 后追加 `addTaskEvent(..., "published", ...)`。注意 `publishTask` 接受 `Pool | PoolClient`,事件随调用方事务。
- `claimed`:`claimNextTask`(`queries.ts:873`)是单条 `WITH ... UPDATE ... RETURNING`,认领成功(`rows[0]` 存在)后在同函数追加事件。**同理可给 `claimNextResumableTask`/`claimNextRejectedTask` 落 `resumed`/`rerun_started`**——但这两个标签语义是「恢复执行」,放在 executor 里跑 Claude 前落更贴近「真的开始跑」,二选一即可。**决策**:claim 类只落 `claimed`(进入队列被领取);`resumed`/`rerun_started`/`retry_started` 由 executor 在 `ensureWorktree` 后、`runTaskClaude` 前落(确保「恢复执行」事件确实对应一次 Claude 调用)。
- `resumed` / `rerun_started` / `retry_started`:分别在 `resumeTask` / `rerunRejectedTask` / `retryFailedTask` 中 `runTaskClaude` 调用前 `addTaskEvent`。
- `worktree_prepared`(可选):四条入口 `ensureWorktree` 后统一落,payload 带 `{ workBranch, fresh }`。
- `claude_turn_finished`(可选):`handleClaudeTurn` 入口或 `runTaskClaude` 返回后落,payload 带 `{ hitSentinel, resultPreview }`(`resultPreview` 截断,避免大文本入库)。

> 注:`claimed` 也可改在 `runner.startActive`(`runner.ts:832`)落,但那里无 DB 事务上下文且与 claim 解耦,容易和「认领但启动失败」错位 —— 仍以放 `claimNextTask` 内为准。

### 3.4 前端 UI

数据来源不变(仍是聚合端点的 `events`),改造集中在展示:

1. **`EVENT_LABEL` 补全**(`task-detail-shared.tsx:19-26`):覆盖**全部** event_type(中文标签),并扩展为 `{ label, icon, tone }`,复用 `shared.tsx` 的 `Tone`/图标体系。失败类(`failed`/`auto_reply_blocked`/`auto_merge_failed`)用 `failed` tone(红);恢复类(`resumed`/`rerun_started`/`retry_started`)用循环箭头图标 + `rejected`/`running` tone,视觉标识「又跑了一轮」。
2. **保留执行阶段条**作为顶部概览(粗粒度速览)。
3. **细颗粒度事件流按「轮次」分组**:以「执行起点」事件切段,每轮一个可折叠块(标题如「第 2 次执行 · 失败」),默认展开最新一轮 + 终态轮。轮内事件按时间顺序排列(`worktree_prepared → committed → pushed → pr_created → …`)。
4. **失败事件节点高亮 + 重试入口**:`failed` 节点红色,若任务**当前状态 = failed**,在该节点旁渲染「重试」按钮(§4.5),点击调重试 API。
5. **事件可展开 payload**:点开看 `error_message`(failed)、`question`(waiting)、`prUrl`(pr_created)、`feedback`(rejected)等;`claude_turn_finished` / `running` / `resumed` 节点带「查看执行详情 →」跳「Claude Code 执行」Tab。
6. 空态文案保留(`task-detail-timeline.tsx:49`)。

样式落点:`apps/console/app/globals.css` 既有 `.timeline`/`.tl-*`(935-1002)与 `.lc-*`(2333-2397),新增轮次分组/折叠/重试按钮样式复用现有 token。

## 4. 设计:失败节点续接重试(G2)

### 4.1 语义

**续接重跑**(复刻打回重跑):`failed → running`,Worker 用 `task.claude_session_id` resume 同一 Claude 会话,把**失败原因(`error_message`)**作为新一轮 prompt 输入(类比打回重跑把 `feedback` 作为输入),让 Claude 带着「上次为什么失败」继续修。**不**清空运行态、**不**回草稿。

与现有 `reactivateTask`(清空回草稿)并存,二者面向不同诉求:重试=带上下文接着干;激活=推倒重来。

### 4.2 状态流转与机器锁定

- 新增 `claimNextRetryableTask(client, workerId)`(`queries.ts`):`WHERE status='failed' AND claimed_by=$1`(机器锁定,与 `claimNextRejectedTask` 同构,只重试本机失败的任务)+ `FOR UPDATE SKIP LOCKED` → UPDATE status='running'。
- 触发不自动:`failed` 不会被动重试 —— **必须用户在 UI 点「重试」**。点击后置一个「待重试」信号,Worker 下一轮 `claimAndStartOne` 才认领。
- 「待重试」信号的两种实现(§4.3 决策):
  - (a) 直接 `failed → running`(由 API 调一个 `requestTaskRetry`,在事务内翻 running 并落 `retry_started`),Worker 看到自己名下的 running 任务……**不行**:running 不在任何 claim 谓词里,Worker 不会捡。
  - (b) **推荐**:API 仅校验+落一个 `retry_requested` 事件/标记,真正的 `failed→running` 由 Worker 的 `claimNextRetryableTask` 完成(与打回链一致:Console `rejectTask` 只翻到 `rejected`,Worker 再 `claimNextRejectedTask` 翻 running)。
    - 但 `rejected` 是独立状态;`failed` 直接做 claim 谓词即可,无需新状态 —— `claimNextRetryableTask` 谓词 `status='failed' AND claimed_by=workerId AND <带重试标记>`。
    - 重试标记:复用「数事件」法 —— 谓词附加「存在 `retry_requested` 事件且其后无 `retry_started`」。或加一个轻量布尔列(见 §6 迁移)。**决策点**:无标记则 Worker 会把**所有** failed 任务自动重试,违背「用户主动」——必须有标记区分「用户已请求重试的 failed」与「就停在 failed 的」。倾向加列 `retry_requested_at timestamptz`(语义清晰、可索引、避免事件计数竞态)。

### 4.3 worktree / session 恢复策略(关键 trade-off — 需 review 拍板)

失败时工作树已删(`executor.ts:544/587/630`),续接重试需重建。按失败时点分三类:

| 失败时点 | 有 session? | 有远端 work_branch? | 续接重试能恢复什么 |
|---|---|---|---|
| Claude 跑之前(fetch/worktree/claude 不可用) | 否 | 否 | 退化为全新执行(从 base fresh,等同 executeTask) |
| Claude 跑后、commit 前(进程失败/解析失败) | 取决于 session 是否已落库 | 否 | session 在则 resume(Claude「记得」做过什么);**未提交的工作树改动已随删树丢失** |
| commit/push 之后(如 `gh pr create` 失败) | 是 | 是 | 从 work_branch 重建工作树(提交保留)+ resume session |

**诚实结论**:续接重试可恢复的上下文 = **Claude session 对话记忆 + 已 push 到 work_branch 的提交**;**未提交/未推送的工作树文件改动在失败删树时已丢失**。session resume 通常能让 Claude 重新生成改动,但不保证文件级精确还原。这与打回重跑不同(打回必来自 success,一定 push 过,总能从 work_branch 还原)。

`retryFailedTask` 执行器(新增,`executor.ts`,仿 `rerunRejectedTask`):
1. `getTaskLocalPath`,校验。
2. `ensureWorktree`:`work_branch` 远端存在 → `fresh:false` 从分支重建;不存在 → `fresh:true` 从 `origin/base_branch`(改动靠 session 重做)。
3. `runTaskClaude`:`task.claude_session_id` 存在 → resume + `retryPrompt(error_message)`;不存在 → 全新 `taskPrompt(task)`(等同初次)。
4. `handleClaudeTurn` 收尾(复用,`pr_url` 存在则复用 PR)。
5. catch → `markTaskFailed`(可再次重试)。

`retryPrompt(task, errorMessage)`:新增,内容形如「上一轮执行失败:<error_message>。请在当前分支修复并完成任务」+ `replyDirective(task)`(复用 `executor.ts:244`)。

> **备选(更强保留,trade-off)**:`markTaskFailed` 时**不删工作树**且把 failed 纳入 GC keep 集,直到重试/激活——可保住未提交改动,但代价是失败任务的工作树长期占盘 + GC 逻辑复杂化(`listActiveTaskIdsForWorker` / `gcWorktrees` 都要改)。默认方案取「删树 + 靠 session/分支恢复」,此备选列入开放问题由 review 定。

### 4.4 重试上限

用户主动触发,不设硬上限(无限重试是用户的选择)。但:
- UI 展示「第 N 次重试」(数 `retry_started` 事件,仿 `countAutoReplyRounds`,`executor.ts:71-77`)。
- 可选软提醒:连续 ≥3 次失败时 UI 提示「考虑改用『激活回草稿』重写任务」。不阻断。

### 4.5 入口

三处,语义一致(都打「请求重试」):
- **Console 详情页**:`TaskReviewActions`(`task-detail-overview.tsx:127`)目前仅 success 显示。扩展为 failed 时显示「重试(续接)」+「激活回草稿」两按钮(后者复用既有 reactivate)。
- **时间线失败节点**:§3.4-4,失败事件旁直接「重试」(同一 API)。
- **Worker 桌面端**:`runner.ts` 已有 `acceptMyTask`/`rejectMyTask`(386,361);新增 `retryMyTask(taskId)`,failed 分组任务加「重试」按钮。

### 4.6 API

- 新增 `requestTaskRetry`(`queries.ts`):校验 `status='failed'`,置 `retry_requested_at=now()`(+ 落 `retry_requested` 事件,worker_id=null),返回 task 或 null(非 failed)。
- Console:复用 `PATCH /api/tasks/[id]`,新增 `action="retry"`(`route.ts:64` 的 action 分发),仿 `reactivate` 分支(`route.ts:136-143`):调 `requestTaskRetry`,成功 `publishTaskUpserted` + 200,失败 409「仅失败任务可重试」。权限沿用 `task.create`。
- Worker:`claimNextRetryableTask` 谓词带 `retry_requested_at IS NOT NULL`;`retryFailedTask` 在跑 Claude 前清 `retry_requested_at`(或由翻 running 一并清)并落 `retry_started`。

## 5. 改动清单(预估)

| 文件 | 改动 | 量级 |
|---|---|---|
| `packages/db/migrations/022_*.sql` | (若采纳列方案)加 `tasks.retry_requested_at`;**无 status / event_type 约束改动**。取下一个空闲号前先 `git fetch` 核对 origin/worktree 占用 | 小 |
| `packages/db/src/types.ts` | `Task` 加 `retry_requested_at`;(可选)事件类型常量 | 小 |
| `packages/db/src/queries.ts` | 补 `published`/`claimed` 事件;新增 `claimNextRetryableTask`/`requestTaskRetry`;`resumed`/`rerun_started` 由 executor 落故此处仅 claim | 中 |
| `apps/worker/src/executor.ts` | 新增 `retryFailedTask` + `retryPrompt`;`resumeTask`/`rerunRejectedTask`/`retryFailedTask` 落「恢复执行」事件;(可选)`worktree_prepared`/`claude_turn_finished` | 中 |
| `apps/worker/src/runner.ts` | `claimAndStartOne` 加 retryable 车道(优先级:续接 > 打回 > **重试** > 新任务);`retryMyTask` 桌面方法 | 中 |
| `apps/console/app/api/tasks/[id]/route.ts` | `action="retry"` 分支 | 小 |
| `apps/console/app/ui/task-detail-shared.tsx` | `EVENT_LABEL` 补全为 `{label,icon,tone}` 全集 | 小 |
| `apps/console/app/ui/task-detail-timeline.tsx` | 轮次分组 + 折叠 + 失败节点重试按钮 + payload 展开 + 跳执行 Tab | 中 |
| `apps/console/app/ui/task-detail-overview.tsx` | `TaskReviewActions` 支持 failed 态(重试 / 激活) | 小 |
| `apps/console/app/globals.css` | 轮次分组 / 折叠 / 重试按钮样式 | 小 |
| (Worker 桌面 UI,Electron 渲染层) | failed 分组「重试」按钮 | 小 |

## 6. 迁移

- **补事件:零迁移**(`event_type` 无 CHECK)。
- **失败重试状态:零迁移**(`failed→running` 无新状态)。
- **唯一可能的迁移**:重试请求标记列 `tasks.retry_requested_at timestamptz`(§4.2 决策若取「列」而非「数事件」)。取下一个空闲编号(当前最新 `021`,**实现时先 `git fetch` 核对 `origin/main` 与各 `worktree-*` 占用**,避免撞号),并按惯例无需动 `tasks_status_check`。

## 7. 实施计划(分阶段,每阶段可独立验证)

1. **P1 DB 事件补全 + 重试基建**:queries 补 `published`/`claimed`;新增 `requestTaskRetry`/`claimNextRetryableTask`(+ 可选 migration 022);typecheck + ephemeral DB 迁移自检。
2. **P2 Worker 执行埋点 + 重试执行器**:`resumed`/`rerun_started`/`retry_started`(+ 可选 `worktree_prepared`);`retryFailedTask`/`retryPrompt`;`runner` retry 车道 + `retryMyTask`。
3. **P3 Console API**:`action="retry"`。
4. **P4 前端时间线 UI**:`EVENT_LABEL` 全集 + 轮次分组 + 失败节点重试 + payload 展开 + 跳转;`TaskReviewActions` failed 态。
5. **P5 端到端验证**:见 §8。

## 8. 验证计划

按需求方既往要求,改动跨多形态、会迭代多轮,**走 `docs/acceptance/task-event-timeline-retry/` 证据链**(matrix.csv + round-N.md)。核心用例:

- 本地顺序:`npm run typecheck` → `npm run build` → `npm run db:migrate`(或 `node scripts/ephemeral-db.mjs --verify`) → `npm run verify:console`。
- 功能用例(用一次性干净库 + 起 Worker 实跑,**不光看 build 绿**):
  1. 新任务全链:created→published→claimed→running→committed→pushed→pr_created→success→accepted,时间线每节点有事件 + 中文标签。
  2. waiting/续接:命中哨兵→waiting→用户回复→**resumed 事件出现**→success。
  3. 打回重跑:reject→**rerun_started 事件**→复用 PR→success。
  4. **失败续接重试**:构造 failed(如 claude 不可用 / pr create 失败)→ UI 点重试→`retry_requested`→`retry_started`→running→(成功路径)success;验证 session resume 生效、`pr_url` 复用。
  5. 失败重试边界:Claude 跑前失败(无 session)→ 重试退化为全新执行不报错;多次失败→「第 N 次重试」计数正确。
  6. 轮次分组 UI:多轮失败重试 / 打回的时间线按轮折叠正确,失败节点重试按钮仅在 `status=failed` 时出现。

## 9. 开放问题 / 盲点(待 review 拍板)

1. **失败时是否保留工作树**(§4.3 备选):默认「删树 + 靠 session/分支恢复」(未提交改动丢失);备选「保留树 + GC 豁免」(保住改动但占盘 + GC 复杂)。**倾向默认**,请确认。
2. **重试标记**(§4.2):加列 `retry_requested_at`(清晰、需迁移)vs 数事件(零迁移、有竞态风险)。**倾向加列**。
3. **可选增强裁剪**(§3.2):`worktree_prepared`/`claude_turn_finished` 要不要做?做则时间线更细但事件量更大。**倾向先只补断点(必做项),增强项二期**。
4. **`claimed` 事件归属**:认领瞬间 worker_id 已知,事件 worker_id 填认领者 —— 确认无歧义。
5. **盲点**:Worker 桌面端(Electron 渲染层)的具体改法本 spec 只标了入口(`runner.ts` 方法),未深入渲染组件文件 —— P2/P4 实现前需补读桌面端任务面板源码再细化。
6. **未覆盖**:`cancelled`(用户主动取消)是否也给「重试」?本期判定**不给**(取消是用户意图终止,需要重来用「激活回草稿」),如需请提出。
