# Worker 桌面端 Agent-View 式任务面板

## 背景与目标

worker 桌面端(`apps/worker`)当前的「在途任务」卡片(`main.ts:228-231`)数据来自 runner 的 in-memory `active` map(`runner.ts:264-272`)——**只看得到正在跑的任务**;本 worker 已完成 / 等待中 / 失败 / 已合并 / 待审的历史任务在桌面端**完全不可见**。

目标:借鉴 Claude Code 官方 Agent View(`claude agents`)的信息架构与交互范式,在 worker 桌面端做一个**本机视角的任务总览 + 监控 + 轻管理**面板:全量任务按状态分组、每行摘要、点开看评论/事件流(peek)、对 `waiting` 任务直接回复、对 `success` 任务打回重跑。

> 注意:数据**不**对接 Claude 的 Agent View / supervisor(那是 Claude Code 自己的 session,本项目有独立的 DB 协同层)。本面板纯粹基于本项目 DB(`tasks`/`task_comments`/`task_events`)重排展示。结论见 `docs/spec`(无对应文件,见会话决策):Agent View 是 research preview + 单机本地 + 无 headless reply,不适合作 worker 执行内核;但其 UI 范式值得搬到 worker 自有面板。

## 范围与定位(已与用户敲定)

- **深度**:监控 + 本机回复处理。即 ① 只读总览(分组/摘要/peek/PR 标签/时长) ② `waiting` 任务可在 worker 端回复 ③ `success` 任务可打回重跑。
- **任务范围**:**仅本 worker**(`tasks.claimed_by = <workerId>`)。
- **不做**(归 Console 职责,避免重复造轮子):新建/下发任务、用户管理、跨 worker / 跨项目总览。
- **与 Console 分工**:Console = 多 worker 协同 + 远程下发/验收(已完整:`apps/console/app/ui/{tasks,task-detail,workers}.tsx` + `api/tasks/[id]/{comments,events,review}`);worker 桌面端 = 本机一眼看清「在跑什么 / 谁卡住 / 谁待审」+ 本地能力(打开 worktree、看本机执行日志、本机取消)。回复/打回与 Console 走**同一 DB 路径**,天然一致、无并发冲突。

## 状态分组映射

`TaskStatus`(`types.ts:1-13`)全集:draft/scheduled/pending/claimed/running/waiting/success/merged/accepted/rejected/failed/cancelled。本 worker(`claimed_by=workerId`)只会持有已认领过的任务,故 draft/scheduled/pending(未认领,`claimed_by=null`)天然不出现。

Agent-View 式分组(顶部最需要人):

| 分组(UI) | 包含 status | 行内操作 | 备注 |
| :-- | :-- | :-- | :-- |
| 需输入 Needs input | `waiting` | **回复** | 摘要取它在等的问题(最后一条 worker 评论);可回复触发续接 |
| 待审 Ready for review | `success` | **打回**(可选:验收通过) | 带 PR 标签;打回触发重跑 |
| 进行中 Working | `claimed` / `running` / `rejected` | 取消(已有) | `rejected` = 已打回待重领重跑,归此组 |
| 已完成 Completed | `merged` / `accepted` / `failed` / `cancelled` | — | 折叠展示;`failed` 保持可见 |

**一行摘要**(只用列表自带的 Task 字段,不为每行多查一次):`waiting` → 「⚠ 等待你的回复」(问题正文移到 peek 顶部显示);`failed` → `error_message`;其余 → `project_name · work_branch`。
**PR 标签**:`pr_url` 存在时显示,颜色按 `merge_status`(`types.ts:16`)+`status`:`merged`/`merge_status=merged` → 紫;`success` 待审 → 绿;其余/`unknown` → 黄。`submit_mode=push` 无 PR → 显示「直推 <target_branch>」。

## 数据与查询

**新增**(`packages/db/src/queries.ts` + `index.ts` 导出)——理由:`listTasks`(`queries.ts:314`)面向 Console 分页列表(强制 limit/offset/total + 项目范围 + keyword),语义不匹配「本 worker 全量按状态分组」;不改其公共签名以免影响 Console:

```ts
// 本 worker 认领过的全部任务(含 project_name),按 updated_at desc。供 worker 桌面端面板。
export async function listWorkerTasks(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  limit = 200
): Promise<Task[]>
//  SELECT tasks.*, projects.name AS project_name FROM tasks
//    JOIN projects ON projects.id = tasks.project_id
//   WHERE tasks.claimed_by = $1 ORDER BY tasks.updated_at DESC LIMIT $2
```

**复用**(均已存在,worker 已 import `@claude-center/db`):
- peek:`listTaskComments(client, taskId)`(`queries.ts:1031`) + `listTaskEvents(client, taskId)`(`queries.ts:368`)。
- 回复:`addTaskComment(client, {taskId, author:"user", workerId:null, body})`(`queries.ts:1018`)。与 Console comments route(`comments/route.ts:54`)同。worker 下轮 `claimNextResumableTask` 经 `getPendingReply`(`queries.ts:1043`)侦测续接。
- 打回:`rejectTask(client, taskId, feedback)`(`queries.ts:766`)。需事务(内部 FOR UPDATE + 多语句),照 review route(`review/route.ts:34-54`)用 `getPool().connect()` + BEGIN/COMMIT/ROLLBACK。返回 null = 非 success 态 → UI 提示「任务不在待审状态」。
- (可选)验收:`acceptTask`(`queries.ts:748`),同事务模式。

## runner / IPC / preload 改动

**`runner.ts`** 新增方法(ClaudeCenterWorker,均 `getPool()`):
- `listMyTasks(): Promise<Task[]>` → `listWorkerTasks(getPool(), this.config.workerId)`。
- `getTaskDetail(taskId): Promise<{comments, events}>` → `listTaskComments` + `listTaskEvents`(peek)。
- `replyToTask(taskId, body): Promise<void>` → `addTaskComment(author:user)` + `void this.tick()`(催一轮认领续接)。校验:body 非空。
- `rejectMyTask(taskId, feedback): Promise<{ok:boolean}>` → 事务 `rejectTask`;成功 `void this.tick()`;返回 ok=false 表示非 success 态。
- (可选)`acceptMyTask(taskId): Promise<{ok:boolean}>` → 事务 `acceptTask`。

> 归属校验:本机面板操作信任本机用户;`listWorkerTasks` 已限定 `claimed_by=workerId`,UI 只对面板内的任务发起回复/打回,误操作面小。如需更稳可在 reply/reject 前校验 task.claimed_by==workerId,但非必须。

**`preload.cjs`**:`workerApi` 增 `listMyTasks / getTaskDetail / replyToTask / rejectMyTask`(/ `acceptMyTask`)。
**`main.ts`**:增对应 `ipcMain.handle`;改造 UI(下节)。

## UI 设计(`main.ts` 内联 HTML)

- **「任务」卡片**替代现「在途任务」:渲染 4 个分组(空组隐藏),组内行:状态图标(复用 CSS 变量色 `--waiting/--running/--success/--failed/--cancelled`)+ 标题 + 一行摘要 + 时长 + PR 标签 + 行操作按钮。已完成组默认折叠到「…N 更多」。
- **peek**:点行展开内联面板,拉 `getTaskDetail` 显示 comments(worker/user 区分)+ events 时间线(复用 `.logs` mono 样式)+ `waiting` 的待答问题置顶。
- **回复**:`waiting` 行 peek 内含输入框 + 发送 → `replyToTask` → 刷新。
- **打回**:`success` 行「打回」按钮 → 弹意见输入 → `rejectMyTask` → 刷新;ok=false 提示状态已变。
- **刷新**:`listMyTasks` 纳入现有 3s `refresh()`(或独立 5s);peek 展开期间附带定时拉 `getTaskDetail`。
- 顶部状态行/设置/能力/用量/日志/在途计数**保持不变**(`getStatusSnapshot` 不动)。

**设计取舍**:worker 是 vanilla HTML 字符串(`main.ts` 字符串拼接,无构建),**无法 import** Console 的 React 组件 / `shared.tsx`(`STATUS_META`/`StatusBadge`)。故跨技术栈**不复用代码**,只复用「设计语言」(Claude Light 色板/CSS 变量,`main.ts` 已对齐);worker 内自定义一份 status→图标/文案/色 的小映射。这是 CLAUDE.md「展示原子统一放 shared.tsx」规则的合理例外(那条仅约束 console 包内部)。

## 风险 / 边界

- **并发一致性**:worker 回复/打回与 Console 同走 DB(评论表 + 状态机 FOR UPDATE),无双写冲突。
- **rejected 归属**:`rejectTask` 不清 `claimed_by`,故 rejected/failed/cancelled 仍 `claimed_by=本worker`,面板可见。✓
- **数据量**:`listWorkerTasks` 默认 limit 200 + 已完成折叠;够本机用,超量再加分页。
- **空态**:无任务时显示空态文案(同现有 `.empty`)。
- **command/cleanup 在途可见性**:原「在途任务」卡片会列 direct command / cleanup;新「任务」面板只列 tasks(`listWorkerTasks`)。顶部 meta 的「在途 N/M」(`activeCount`)仍含 command/cleanup 总数,整体在途感知不丢;如需单列可后续补。

## 验证计划

1. `npm run typecheck`(db/console/worker 三包)+ `npm -w @claude-center/worker run build`。
2. worker GUI 难自动驱动,按既有「worker headless 验证套路」:`db build` + tsx 脚本对**一次性干净库**(`scripts/ephemeral-db.mjs`)seed 出本 worker 各状态任务(waiting/running/success/merged/failed)+ 评论/事件 → 直接调 `ClaudeCenterWorker` 的 `listMyTasks/getTaskDetail/replyToTask/rejectMyTask` 断言返回与 DB 变更(回复落 user 评论、打回翻 rejected)→ 清理。
3. 人工:`npm -w @claude-center/worker run dev` 起 Electron,对 dev 库已有任务肉眼核对分组/peek/回复/打回。
4. 落 `docs/acceptance/worker-agent-view-panel/`(matrix.csv + round-N.md)若需证据链。

## 改动面清单

| 文件 | 改动 |
| :-- | :-- |
| `packages/db/src/queries.ts` | +`listWorkerTasks` |
| `packages/db/src/index.ts` | 导出 `listWorkerTasks` |
| `apps/worker/src/runner.ts` | +`listMyTasks/getTaskDetail/replyToTask/rejectMyTask`(/`acceptMyTask`) |
| `apps/worker/preload.cjs` | 暴露上述 API |
| `apps/worker/src/main.ts` | +IPC handlers;「任务」卡片分组/peek/回复/打回 UI + CSS |
| `README.md` / `apps/worker` 文档 | 同步桌面端新能力(硬线 10) |

预估:DB+runner+preload 小(~80 行);main.ts UI 中等(~200 行 HTML/JS/CSS)。无 schema 变更、无迁移。

## 取舍决定(已敲定)

1. `success` 任务**一并加「验收通过(accept)」**(与打回对偶,复用 `acceptTask`,本机闭环验收:通过→accepted / 打回→重跑)。
2. 已完成组 limit 200 + 不按项目二级分组。

> `index.ts` 为 `export * from "./queries.js"`,新增 `listWorkerTasks` 自动导出,**无需改 `index.ts`**(改动面清单中该行作废)。
