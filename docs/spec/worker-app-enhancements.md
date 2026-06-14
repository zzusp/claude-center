# Worker 桌面应用功能完善

## 背景与目标

`apps/worker` 的**执行链路**已相当完整(注册/心跳、工作树隔离真并发、Claude 会话续接、PR/push/自动合并、合并清理、用量采集)。但**桌面应用本身很薄**:Electron 窗口只有「工作态」「允许远程」两个开关 + 一行状态文字;项目关联只能靠手写 `CLAUDE_CENTER_PROJECTS` 环境变量 JSON;中控无法真正中断在途任务;缺少能力自检与可观测。

本次按用户选定的四个方向完善(四向汇聚到同一个面:**扩展状态模型 + IPC 接口 + 富渲染界面**,加少量后端机制):

1. **桌面 UI 增强** — 窗口展示能力自检、用量仪表、关联项目、在途任务、最近日志
2. **项目关联可视化** — 桌面端选本地文件夹 → 关联云端项目(取代手写 env JSON),并发数 UI 可调
3. **任务可控性** — 中控取消在途任务时 worker 真正杀 Claude 进程;启动检测 git/gh/claude 可用性
4. **健壮性/可观测** — 任务执行关键步骤落 `task_events` 供 Console 查看;内存日志环供桌面面板;DB 错误不打断主循环

## 设计

### A. 能力自检(inspect.ts)— 方向 3a

新增 `detectCapabilities(config)`:并行跑 `git --version` / `gh --version` / `claude --version`,返回
```ts
type Capability = { ok: boolean; version: string | null };
type Capabilities = { git: Capability; gh: Capability; claude: Capability };
```
- 启动时采集一次,缓存进 runner;`registerWorker` 的 `capabilities` 用真实结果替换原硬编码 `{git:true,...}`。
- `executeTask` 跑 Claude 前预检:`claude` 不可用直接 `markTaskFailed("claude CLI not found on this worker …")`,不再让任务以晦涩 spawn 错误跑挂。
- 快照里带 capabilities,UI 用红/绿点展示。

### B. 可持久化项目关联 + 并发数(config.ts)— 方向 2

`worker.json` 由 `{workerId, allowRemoteControl}` 扩展为:
```jsonc
{ "workerId": "...", "allowRemoteControl": false, "maxParallel": 1,
  "projects": [{ "projectName": "foo", "localPath": "D:\\code\\foo" }] }
```
- 启动时 `projects = env(CLAUDE_CENTER_PROJECTS) ∪ persisted`(按 `projectName|repoUrl + localPath` 去重),都经 `upsertWorkerProjectLink` 注册。env 来源标记 `source:"env"`(UI 只读),本地添加标记 `source:"local"`(UI 可删)。
- `maxParallel`/`allowRemoteControl` 初值:`worker.json ?? env`。UI 改动后持久化并即时上报 DB。
- `config.ts` 持久化函数从单一 `persistAllowRemoteControl` 泛化为读改写整个 `WorkerState`(保留 workerId)。

### C. 新增 DB 查询(packages/db/src/queries.ts)— 无 schema 变更项

- `listWorkerProjectLinks(client, workerId)` → 该 worker 的关联(join projects 取 name/repo_url/default_branch)。UI 列表用。
- `removeWorkerProjectLink(client, {workerId, projectName?, repoUrl?, localPath})` → 解析 project 后 `DELETE` 对应链接行。UI 删除用。

### D. 取消在途任务 — 方向 3b(唯一跨切面项:迁移 + DB + worker 杀进程 + Console 触发)

**迁移 015_task_cancel_request.sql**(additive,`cancelled` 状态自 001 起即合法,无需重建约束):
```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
```

**DB 查询**:
- `requestTaskCancellation(client, taskId)` → `UPDATE … SET cancel_requested_at=now() WHERE id=$1 AND status IN ('claimed','running','waiting') RETURNING *`;落 `cancel_requested` 事件。非在途返回 null(Console 提示不可取消)。
- `listCancelRequestedTaskIds(client, workerId)` → 该 worker 名下、在途、`cancel_requested_at IS NOT NULL` 的任务 id。
- `markTaskCancelled(client, taskId, workerId, result)` → `status='cancelled'`(守卫 `status IN ('claimed','running','waiting')`),落 `cancelled` 事件。
- **`markTaskFailed` 加守卫 `AND status <> 'cancelled'`**:防取消后执行链 catch 的 `markTaskFailed` 把 `cancelled` 覆盖回 `failed`(精确改动,对现有流程零影响——现有调用点任务都处于 claimed/running/waiting)。

**worker 杀进程**:
- `shell.ts`:`runCommand`/`runPowerShell` 加 `onSpawn?(child)` 回调暴露子进程;新增 `killProcessTree(pid)`(win32 走 `taskkill /PID <pid> /T /F` 杀整棵树,否则 `child.kill()`)。
- 仅注册 **Claude 子进程**(长极点,最长 60min);git/gh 是秒级,取消落在 git 收尾窗口时让其跑完,detection 见任务已终态即 no-op。
- `executor.ts`:`runClaudeJson` 经 options 透传 `onSpawn`;`executeTask`/`resumeTask`/`rerunRejectedTask` 增 `onSpawn` 形参向下传。
- `runner.ts`:`active` 从 `Map<string,Promise>` 升级为 `Map<string,ActiveEntry>`(含 `taskId/kind/title/startedAt/child/cancelled`,兼做 UI 在途列表数据源)。新增 `cancelTimer`:周期 `listCancelRequestedTaskIds` → 命中且未 cancelled 的 entry **先 `markTaskCancelled`(抢占终态)再杀进程树**;Claude run 随即 reject,executor catch 的 `markTaskFailed` 因守卫成 no-op,worktree 由 catch 清理。顺序保证取消确定性。

### E. 可观测 — 方向 4

- 执行关键步骤落 `task_events`(已有 `addTaskEvent`):`claude_started`/`claude_finished`、`committed`、`pushed`、`pr_created`。Console 任务详情即可见进度。
- runner 内存**日志环**(最近 N=200 条 `{ts,level,msg}`):`console.log/error` 包一层 push 进环,桌面日志面板展示。
- 心跳/info/poll 定时器回调已 `.catch`;补一条:DB 连不上时日志环记一条 `db_error` 但不抛(主循环不死)。

### F. IPC + 渲染(main.ts / preload.cjs)— 方向 1

扩展 IPC:`getState`(富快照)、`setWorking`、`setAllowRemote`、`setMaxParallel(n)`、`listCloudProjects()`、`pickFolder()`(`dialog.showOpenDialog` openDirectory)、`addProjectLink({projectName,localPath})`、`removeProjectLink({projectName,localPath})`、`cancelTask(taskId)`。

渲染分区:状态头(claude 版本/订阅/在途)· 用量仪表(5h/7d 利用率条)· 能力自检(git/gh/claude 红绿点)· 关联项目(列表 + 选文件夹添加/删除)· 在途任务(标题/时长 + 取消按钮)· 设置(并发数 + 两个开关)· 日志面板。

### G. Console 取消入口 — 方向 3b 端到端

复用 `PATCH /api/tasks/[id]`(现处理 `publish`/`complete`):新增 `action:"cancel"` → `requestTaskCancellation`,权限 `task.create`(publisher/admin,与 publish/review 一致)。任务详情页在途态(claimed/running/waiting)显示「取消任务」按钮 → PATCH → 轮询刷新。Console 既有 worker 详情抽屉把 `capabilities` 原样 `JSON.stringify` 展示,新结构自动可见。

## 验证计划

- `npm run typecheck`(全 workspace)+ `npm -w @claude-center/worker run build`
- DB:`npm run db:migrate` 应用 015;脚本对 dev 库验证 `requestTaskCancellation`/`listCancelRequestedTaskIds`/`markTaskCancelled`/`listWorkerProjectLinks`/`removeWorkerProjectLink` 行为(seed 任务 → 请求取消 → 见列表 → 标记 → 守卫生效)。
- 杀进程机制:脚本 spawn `powershell Start-Sleep 60`,`onSpawn` 捕获 → `killProcessTree` → 断言进程消失。
- 能力自检:headless 跑 `detectCapabilities` 打印真实 git/gh/claude 版本。
- config 持久化:`worker.json` 读改写 round-trip(添加/删除项目、改并发数)。
- Electron 主进程能启动注册(GUI 渲染在后台会话受限,以 build + 主进程 boot 为证)。

## 边界

- 取消为 **best-effort**:只中断长时 Claude 轮;落在 git 收尾秒级窗口时任务可能已成功完成(detection no-op)。
- 不引入新依赖、不改协调模型(仍 PostgreSQL 短轮询)。
- 渲染层是原生 HTML+IPC(沿用现状),不引入前端框架。
