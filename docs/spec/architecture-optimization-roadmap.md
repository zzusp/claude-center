# ClaudeCenter 架构与代码优化路线图

> 全量代码与架构分析的开工前快照(2026-06-16)。本文是分阶段优化建议,**非已实施记录**;实施进展以各特性的 PR / acceptance 为准,本文不回头维护。

## 背景

ClaudeCenter 在 50+ PR 内快速堆叠功能(任务流、中途确认、验收/依赖、定时、合并检查、直连对话、SSE 中转、RBAC…),典型的高速迭代积累。本次目标:**全量分析代码与架构、产出分阶段优化路线图**。

分析覆盖三大块:① 数据层 + Console 后端 ② Console 前端 ③ Worker + Relay。会写进路线图的关键断言均**亲自核验源码 + 主动找反证**(见末尾「反偏置校准」)。

规模(约 14.5k 行源码):

| 包 | 行数 | 说明 |
| --- | --- | --- |
| `apps/console` | 7243 | Next.js Web 中控台(API + UI) |
| `apps/worker` | 3450 | Electron 桌面 Worker |
| `packages/db` | 2719 | schema + 20 个迁移 + 共享查询 |
| `apps/relay` | 437 | 可选 SSE 中转 |
| `packages/relay-client` | 358 | 中转共享客户端 |

---

## 整体评价(先说结论:地基稳,债在表层)

**架构本身是健康的、务实的,不需要推倒**:

- **DB 唯一权威 + 双向轮询 + 可选 SSE 叠加**:降级路径天然(SSE 挂了退回轮询、功能不降级),是这类多端协同的正确选型。
- **并发正确**:`claimNextTask` / `claimNextConversationTurn` 用 `FOR UPDATE SKIP LOCKED`;Worker `tick()` 有 `this.claiming` 守卫、`tickConversation()` 有 `conversationBusy` 守卫且各退出路径都复位。
- **隔离干净**:每任务独立 git worktree;console/worker/relay 三进程职责清晰;大字段(session jsonl)用侧表(`task_sessions` / `conversation_sessions`)不污染主查询。

**债集中在「表层」三类**,均为高速迭代的自然产物,可增量偿还:

1. 前端组件膨胀 + 逐字节重复(最确凿、最易修);
2. 后端 route handler 样板重复(项目 scope 检查 / 错误处理 / 入参校验);
3. DB `tasks` 表字段膨胀 + 每次状态迁移重建 CHECK 全集的维护痛点。

---

## 优化路线图(按 ROI 分级)

### P0 — 快赢(高确定性 / 低风险 / 当下就值)

**F1. 抽 Worker 展示组件公共模块**
`apps/console/app/ui/worker-detail.tsx:26-79` 与 `workers.tsx:38-93` 把 `SUBSCRIPTION_LABEL` / `subscriptionLabel` / `isPlanSubscription` / `fmtResetIn` / `UsageBlock` / `WorkingStateBadge` **逐字节复制了两份**。抽到 `app/ui/worker-shared.ts`(或并入 `shared.tsx`),两边 import。
*影响*:消除维护 ×2、口径漂移风险。

**B1. 抽项目级 scope 检查 helper**
`user.role !== "admin" && !(await userHasProject(...))` + `getTaskProjectId` / `conversation.project_id` 两步检查在 **12+ 个 route handler** 重复(`tasks/[id]/route.ts:43-44,84-85,163-164`、`events`、`review`、`session`、`comments`、`conversations/[id]/*`)。
注意:401/403 鉴权门禁**已**统一在 `app/lib/session.ts` 的 `requireUser()` / `requirePermission()`——只需补一个 `requireTaskAccess(user, taskId)` / `requireConversationAccess(user, convId)`(内部一次查询拿 projectId 再判 scope),与现有门禁同风格。
*影响*:去重 + scope 检查不再可能被某个新 handler 漏写(安全相关)。

**B2. 收敛 route handler 错误处理样板**
26 个 handler 各写 `catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : ... }, { status: 500 }) }`。抽一个 `handle(fn)` 包装器或 `errorResponse(e)` 工具,统一 500 格式。
*影响*:一致的错误契约,新增 handler 不再复制粘贴。

### P1 — 结构性(中等工作量 / 改善可维护性与扩展性)

**F2. 拆超大「上帝组件」**(行数已实测核验)

- `task-detail.tsx` **835 行**:单文件管 6 个编辑态 + 3 条独立轮询(`/api/tasks/{id}`、`/events`、`/comments`)+ 嵌 `TaskReviewActions` / `TaskEditForm` / `TaskConversation` / `SessionTranscript`。拆为目录:核心壳 + 各子面板独立文件。
- `tasks.tsx` **609 行**、`overview.tsx` **505 行**、`chat.tsx` **517 行**、`worker-detail.tsx` **457 行** 次第跟进。

*影响*:可读性 / 可测性,后续改单点不再牵动 800 行文件。

**F3. 抽前端公共 hook 消除复制粘贴**

- 异步动作三元组 `busy / error + try/catch/finally` 在 7+ 处复制(`task-detail.tsx:562-563,688-689`、`worker-detail.tsx:106-107`、`workers` / `projects` / `users`)→ `useAsyncAction(fn)`。
- 列表「URLSearchParams 构造 + 分页 state + usePolling」在 `tasks.tsx` / `overview.tsx` / `workers.tsx` 重复 → `useListQuery(endpoint, filters)`。

**F4. 详情页聚合端点(去重 3 条轮询)**
`task-detail.tsx` 每 3s 并发轮询 3 个端点。可让 `/api/tasks/[id]` 返回 `{ task, events, comments }`,单条轮询。
*影响*:轮询期 DB 往返 3→1。注:与 SSE 叠加后收益更明显;非紧急。

**D1. tasks 状态机集中化 + 缓解 CHECK 全集重建痛点**
`tasks` 表字段已横跨「元数据 / 认领 / 执行 / PR 清理 / 取消 / 续接会话」多组,`reactivateTask`(`packages/db/src/queries.ts:224-238`)需手工清 10+ 字段——说明状态转换的「该清哪些字段」散在应用层。建议:

- 把合法状态集合与转换规则收敛到 `packages/db/src/task-state.ts` 单一出处(当前每个迁移重建 `tasks_status_check` 都要手抄全集,易废掉并行分支的新状态——CLAUDE.md 已记此坑)。
- 评估「执行运行态」字段(claimed / started / finished / error / pr / merge / cancel)与「任务定义」字段的关系,**先文档化分组**;是否拆表留作 P2 决策(拆表是 risky 迁移,不轻动)。

*影响*:状态演进时改一处、并行迁移不互踩。

**B3. 入参校验统一到 zod(或等价)**
`tasks/route.ts:89-105`、`review/route.ts:18-25`、`direct-commands/route.ts:12-25`、`conversations/route.ts:26-35` 全手写 if 校验,null / undefined / `trim()` 口径各异。引入 `zod` schema 复用校验规则 + 统一 400 错误。
*影响*:边界条件不再逐个漏。

### P2 — 健壮性 / 可维护性

**W1. worktree 周期性 GC 兜底**
`gcOrphanWorktrees()` 仅在 `start()`(`apps/worker/src/runner.ts:165`)跑一次,无 `setInterval`。inline 清理(进终态即拆)是主路径,但**进程崩溃 / 异常退出留下的孤树要等下次重启才清**。加一个低频(如每 N 个 poll 周期)GC 定时器兜底。
*影响*:长运行 Worker 的磁盘渐进泄漏。

**W2. session jsonl 同步失败重试**
`apps/worker/src/session.ts` 周期同步(任务 20s / 对话 3s)失败是 `catch(() => {})` 静默吞,只靠终态强制同步补救——中间轮失败时 Console 有最长一个周期的「盲窗」。加一次轻量退避重试或至少日志可见。
*影响*:执行过程可见性。

**W3. 配置合并冲突可见**
`apps/worker/src/config.ts:141-153` `mergeProjects`:env 与 local 同 key 时 local 被**静默跳过**,用户无感。加一行日志提示「local 关联被 env 同名项覆盖」。
*影响*:消除用户困惑。

**B4. 调度器 tick 重入一致性**
`apps/console/instrumentation.ts`:`mergeTick` 有 `mergeChecking` 防重入,但 `tick()`(`promoteDueScheduledTasks`)**无**同款守卫。虽是单条幂等 UPDATE、重叠风险低,但应补齐一致性(廉价)。

### P3 — 规模化前瞻(仅当 Console 要横向扩多实例才做)

**S1. 调度器多实例语义**:`instrumentation.ts` 用 `globalThis` 标志 + 纯内存状态(`app/lib/scheduler-state.ts`),README 已自述「单进程成立、多实例为 per-instance 视图」。若未来多实例部署,定时提升 / 合并检查需加分布式锁(PG advisory lock)或单 leader。**当前单进程不是 bug,只是扩展前置**。

---

## 反偏置校准(哪些被夸大 / 被剔除 / 是盲点)

按「先论后证 + 主动找反证」原则,以下初判经亲自核验后**已下修或剔除**,不进路线图:

- **剔除「Worker 对话车道死锁」**:核验 `runner.ts:714-747`,`conversationBusy` 在 null 返回(723)/ conv 缺失(729)/ `.finally()`(738)/ catch(744)**所有路径都复位**,且 `executeConversationTurn` 有 `.catch().finally()` 兜底——复位健壮,无死锁。
- **剔除「Worker tick 重入」**:`tick()` 有 `this.claiming` 守卫(`runner.ts:691-694`)。
- **下修「listWorkers N+1 是性能杀手」→ 非问题**:`queries.ts:502-513` 确有相关子查询,但 worker 数量级为个位~几十(桌面端),无碍;不优化。
- **下修「count(*) OVER() 轮询开销」→ 仅 10K+ 任务才显著**:这类内控台量级远不到,低优先级。

**盲点 / 未当场证伪(标注而非强凑结论)**:

- `setUserProjects` 是否缺事务(DELETE + INSERT)未亲自读源核实,路线图未据此立项,留待实现期核对。
- `app/ui/dashboard-shared.ts` 重定义 `Overview` / `Health` / `ViewKey` 等类型是**刻意权衡**(避免把 db 运行时打进前端包),非纯债;若要消除需另设纯类型子包,收益存疑,暂不立项。
- 多实例是否为真实目标未知(P3 仅作前瞻)。

---

## 实施时的验证口径

各条目**若未来实施**,沿用项目既有 harness:

- `npm run typecheck` → `npm run build`;
- 涉及 instrumentation / 中间件 / 服务端入口的改动**必跑** `npm run verify:console` 看到 `401→200`(build 绿 ≠ dev 绿);
- Worker 改动本地实跑见预期;
- DB 迁移用 `npm run db:ephemeral` 干净库验证(勿拿共享 dev 库)。
