# Worker 详情增强 + 工作状态门控 + 并行执行

> 开工前快照（spec/ 不回头维护）。落地后行为以代码 + README + acceptance 为准。

## 需求

执行机群 worker 卡片点击后的详情,在现有字段基础上**新增**:

1. **Claude Code 版本**（worker 机器上 `claude` CLI 的版本）
2. **订阅类型**:API 计费 vs 套餐订阅（Pro/Max…）
3. **套餐订阅时**展示用量:
   - 5 小时窗口:已用量 + 重置剩余时间
   - 7 天窗口:已用量 + 重置剩余时间
4. **当前 worker 并行处理的任务列表**
5. **并行任务上限**

另外:

6. **工作状态门控**:worker 在线 ≠ 接任务。需在客户端切到「工作状态」才领任务。
   - 客户端有「工作状态 开/关」开关。
   - 客户端有「是否允许 web 端远程开关工作状态」开关。
   - 默认:**上线后空闲不接任务**（必须手动切到工作状态）。

## 关键决策（已与用户确认）

- **并行执行**:做**真并发**——worker 同时跑多个 Claude 任务,可配上限 `max_parallel`。同项目并发用 **git worktree 隔离工作树**（当前严格串行 + 同项目共用一个工作树会冲突）。
- **工作状态默认**:**idle（空闲不接任务）**。

## 数据源（已在本机 ground-truth 实测,2026-06-14）

| 项 | 获取方式 | 稳定性 |
|---|---|---|
| Claude 版本 | `claude --version` → `2.1.177 (Claude Code)`,取前导 `\d+\.\d+\.\d+` | ✅ 公开 CLI |
| 订阅类型 | 读 `~/.claude/.credentials.json`（Win:`%USERPROFILE%\.claude\.credentials.json`,可被 `CLAUDE_CONFIG_DIR` 覆盖）。`claudeAiOauth.subscriptionType`（值如 `max`/`pro`）存在→套餐;否则有 `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`→`api`;都没有→`unknown` | ⚠️ 文件结构非公开 API,容错处理 |
| 用量 5h/7d | `GET https://api.anthropic.com/api/oauth/usage`,头 `Authorization: Bearer <claudeAiOauth.accessToken>`。返回 `five_hour.{utilization, resets_at}`、`seven_day.{utilization, resets_at}`（utilization 为 0–100 百分比,resets_at 为 ISO 时间） | ⚠️ undocumented,失败则 usage=null,不崩 worker |

实测返回样例:
```json
{"five_hour":{"utilization":13.0,"resets_at":"2026-06-13T21:19:59+00:00"},
 "seven_day":{"utilization":32.0,"resets_at":"2026-06-16T05:59:59+00:00"}, ...}
```
**注意**:接口只给「利用率百分比 + 重置时间」,没有「总额度绝对值」。故 UI 的「已用/总」表达为 **「已用 X% + 重置剩余时间」**（进度条）。仅套餐账号有意义。

## 数据模型（migration 012,additive only,对现有列零破坏）

`workers` 新增列:
- `claude_version text`（可空）
- `subscription_type text NOT NULL DEFAULT 'unknown'`（`max`/`pro`/`team`/`enterprise`/`api`/`unknown`）
- `usage jsonb NOT NULL DEFAULT '{}'::jsonb`（`{five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at}, fetched_at}`）
- `working_state text NOT NULL DEFAULT 'idle' CHECK (working_state IN ('idle','working'))`
- `allow_remote_control boolean NOT NULL DEFAULT false`
- `max_parallel integer NOT NULL DEFAULT 1`

**并行任务列表 / 在途数** 不落列,从 `tasks` 派生:`claimed_by = worker.id AND status IN ('claimed','running')`。

## 状态归属（single source of truth）

- **working_state**:**DB 为准**（这样远程开关才生效）。worker 每 tick 从 DB 读它决定是否领任务。本地（Electron）开关与 web 远程都写 DB。register 仅在**新 worker（INSERT）**时置 `idle`;已存在 worker 不被 register/heartbeat 覆盖（保留上次选择,重启不丢）。
- **allow_remote_control**:**客户端为准**（这是客户端策略）。worker 持有,经 info 更新上报 DB。初值来自 env `CLAUDE_CENTER_ALLOW_REMOTE_CONTROL`,运行时经 Electron 开关改,持久化进 `worker.json`。web 远程开关端点服务端二次校验该位。
- **max_parallel**:env `CLAUDE_CENTER_MAX_PARALLEL`（默认 1）,上报 DB 供展示 + 领任务时作上限。

## Worker 改动

### `inspect.ts`（新）
- `getClaudeVersion(config)`:`claude --version` → 解析版本号。
- `readSubscription()`:读凭据文件 + env → `{ subscriptionType, accessToken|null }`。
- `fetchUsage(accessToken, proxy)`:curl 调 oauth/usage（curl 跨平台、可靠认 `-x` 代理）。代理读 `CLAUDE_CENTER_USAGE_PROXY` ?? `HTTPS_PROXY` ?? `HTTP_PROXY`。失败→null。仅套餐账号调。

### `config.ts`
新增:`maxParallel`、`allowRemoteControl`、`usageProxy`、`dataDir`。`worker.json` 扩展为 `{ workerId, allowRemoteControl? }`。

### `runner.ts`(并行调度 + 工作态门控)
- 去掉串行 `polling` guard,改为:`claiming` 仅护住「认领循环」;在途任务放 `active: Map<key, Promise>` 跟踪。
- `tick()`:若 `claiming` 返回;读 DB working_state,非 working 则不认领(在途继续);`while active.size < max_parallel` 反复认领并 fire-and-forget 启动,认不到就 break。
- 新增 `infoTimer`(默认 60s + 启动跑一次):采集 version/subscription/usage + allowRemoteControl/maxParallel,写 `updateWorkerInfo`。
- 暴露给 Electron:`setWorkingState`、`setAllowRemoteControl`、`getStatusSnapshot`。
- 启动后跑 `gcWorktrees`(清理终态任务的残留工作树)。

### `executor.ts` + `worktree.ts`(新):git worktree 隔离
- `worktreePathFor(taskId)` = `<dataDir>/worktrees/<taskId>`。
- `ensureWorktree(localPath, wtPath, {workBranch, baseRef, fresh})`:fresh→`worktree add --force -B workBranch wtPath origin/base`;recover→不存在则 `worktree add --force wtPath workBranch`。
- `removeWorktree(localPath, wtPath)`:`worktree remove --force` + `prune`(容错)。
- 各 flow 用 **wtPath 作任务工作目录**(claude cwd / git `-C`),**localPath 作主仓**(fetch / worktree 管理)。
- cleanup/merged/failed → removeWorktree。
- `gcWorktrees(localPath, activeTaskIds)`:`worktree list` 扫我们目录下、taskId 不在 active 集的,删。

### Electron(`main.ts` + `preload.cjs` + 新 HTML)
窗口加两个开关(工作状态 / 允许远程) + 状态展示。preload contextBridge 暴露 `workerApi`,main 经 ipcMain 调 worker 实例方法,推更新回渲染层。

## Console 改动
- `types.ts` `Worker` 加新字段 + `usage` 结构类型。
- `queries.ts`:`registerWorker`/`updateWorkerInfo`/`listWorkers`(派生 active_task_count) + `setWorkerWorkingState(workerId, state, {viaRemote})`(viaRemote 时校验 allow_remote_control) + `getWorkerRuntime`(working_state+max_parallel) + `listActiveTaskIdsForWorker`。
- API:`POST /api/workers/[id]/working-state`(权限 `command.create`/admin,viaRemote=true)。
- UI:`WorkersView` 详情抽屉补全新字段(版本 / 订阅 / 用量进度条 + 重置倒计时 / 并行列表 / 上限 / 工作态徽标 + 远程开关按钮);卡片显示工作态。

## 风险 / 盲点
- oauth/usage 是 undocumented,Anthropic 可能改。→ 容错 null,UI 优雅降级。
- worktree 生命周期跨 waiting/resume/rejected,要靠 GC + recover 兜底残留。
- 并发写同一主仓(fetch / worktree add)git 自身有锁,安全;但 base 分支 pull 在主仓做,改为只 fetch + 从 origin/base 起 worktree,避免改主仓工作树。
- Electron IPC 为新增面,需实跑验证开关链路。
</invoke>
