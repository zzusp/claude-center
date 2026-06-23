# 失败任务重试问题修复

## 症状

- 任务 `2ee00794-3e52-4ecb-88a9-be179eaf3b2a` 失败后**无法续接重试**：日志显示工作树（worktree）已存在，
  代码仍尝试新建，git 报 `fatal: '<path>' already exists`，重试每次都在 worktree 准备阶段就失败。
- 该任务**也无法通过对话补充信息继续**：任务详情的回复框对失败任务显示「任务非在途」并禁用，用户连一句
  补充都发不出去。

## 根因

### 根因 1：孤儿残留目录撞 `worktree add`（`apps/worker/src/worktree.ts`）

DB ground truth（task 2ee00794，今早日志 + 现场磁盘状态）：

- `error_message`：`git ... worktree add --force -B cc/git-... <wt> origin/main` →
  `fatal: '<wt>' already exists`（exit 128），每次续接重试都卡在这（fresh 路径，因 `claude_session_id` 为空）。
- 现场：`<wt>` 目录**在**、`node_modules`**在**、`.git`**丢失**、`git worktree list` 里**未注册**——典型孤儿目录。

根因链：
- `git worktree remove --force` 在 **Windows + 含 node_modules 的长路径**上常**删不净**——要么整条失败、要么摘了
  git 注册却把目录（连同 node_modules）留在盘上，于是变成「无 .git、未注册」的孤儿目录。GC 不会碰 failed 任务的
  树（在 keep 名单内），所以孤儿一直在。
- `ensureWorktree` 两条路径随后 `git worktree add` 时撞已存在目录：`git worktree add --force` **不豁免**「目标
  目录已存在且非空」（实测 git 2.39.1），且 `removeWorktree` 对未注册孤儿报 `not a working tree`（被容错吞掉），
  目录删不掉 → add 永远 already exists。

关键实测：Node 的 `rmSync(recursive, force)` 能删 >260 长路径 + 只读文件的 node_modules 树（git 自带删除做不到）。
故兜底删目录要用 Node 强删，不能靠 `git worktree remove`。

### 根因 1.b（第三轮才挖到的真因）：Worker 进程**自锁** worktree 的 electron，目录根本删不掉

前两版 fix（rmSync + retries）对**普通仓库**有效，但 task 2ee00794 仍复发。第三轮直接对**真实孤儿目录**实测：

- `rmSync` → `EBUSY: ... unlink '...\node_modules\electron\dist\resources\default_app.asar'`
- `Rename-Item`（改名挪开）→ `Access denied`
- Restart Manager(`rstrtmgr.dll` RmGetList) 查锁主 → **PID 58096 = 运行中的 Worker 本身**（`electron .`，主检出）

即：被开发的仓库就是 claude-center（electron 应用），worktree 里 `npm install` 装出 `node_modules/electron`，而
**运行中的 Worker（electron 进程）持有该 worktree 内 `default_app.asar` 的 OS 句柄（自锁）**。只要 Worker 在跑，
该目录就**无法删除、无法改名**——`git worktree remove` / `rmSync` / `rename` 全失败，`git worktree add` 必然
`already exists`，**任何删除逻辑都无解**。`node_modules/electron` 经核验是真实安装（非 junction）、`default_app.asar`
单链接（非 hardlink）。

### 根因 1.c（第四轮挖到**真正**机制，解释「拉新代码 + 重启 worker 仍每轮复发」）：Electron asar 集成自锁

「重启 worker 也没用」否定了「进程偶发持锁、重启即释放」的假设。第四轮在**真实 Electron 进程**里复现 + 验证：

- Electron 给 Node `fs` 打了 **asar 集成补丁**：任何 fs 操作碰到 `.asar` 文件就把该归档**打开并进程级缓存/映射、整个进程
  生命周期不释放**。
- 于是 Worker（Electron 进程）用 `rmSync` 删 worktree 内 `node_modules/electron/dist/resources/default_app.asar` 时，
  asar 补丁把它**自锁**住 → 删不掉（实测报 `ENOTEMPTY`/`EBUSY`）→ 目录残留 → `git worktree add` 撞 `already exists`。
- **每个新 Worker 第一次清理 rmSync 都会重新自锁** → 这就是「拉最新代码 + 重启 worker 仍每轮复发」的真因（#149 加了
  rmSync、#151 加了 maxRetries 都没用，因为根本不是瞬时锁，而是 Electron 自身对 asar 的永久缓存）。
- Restart Manager 确认锁主就是当前运行的 Worker 进程本身（pid 不随用户「重启」改变，证明其「重启」并未真正杀掉该
  `npm run dev` 的 electron 进程；但即便真换了新进程，新进程第一次 rmSync 仍会自锁，故重启本就治不了本）。

**修复（已在真实 Electron 验证）**：删除窗口内临时 `process.noAsar = true`，让 `.asar` 当普通文件删、不缓存不映射。
证据：`scripts/proof-electron-asar-lock/`（真 electron.exe 跑两次）——默认 asar 集成 → `rmSync` 删不掉（复现）；
`process.noAsar=true` → 删干净（修复）。该 fix 部署后**重启一次即自愈**：新 Worker 的清理 rmSync 不再自锁，删掉残留 → add 成功。

### 根因 2：失败任务无会话时不允许回复续接

- DB `claimNextResumableTask` 要求 `claude_session_id IS NOT NULL` 才认领终态任务——失败在 worktree 准备
  阶段时 Claude 还没产出 session，永远认领不到。
- Console 回复框 `terminalResumable` 同样要求 `Boolean(task.claude_session_id)`，失败任务（无会话）回复框
  被禁用并显示「任务非在途」。
- Worker `resumeTask` 直接 `throw` 当 `!claude_session_id`，没有「无会话则全新执行」的分支。

## 修复

1. `apps/worker/src/worktree.ts`：把 robust 删除收敛进 `removeWorktree`——`git worktree remove`（摘注册、尽量
   删盘）→ `rmWorktreeDir`（Node `rmSync` 强删，兜住 git 删不净的 node_modules 孤儿，带 maxRetries 兜瞬时锁）→
   `prune`。fresh 与 recover（`.git` 不在的孤儿分支）都改为调用它再 `worktree add`；recover 仍优先复用有效工作树
   （`.git` 存在即返回，保住未提交改动）。GC 走同一 `removeWorktree`，顺带不再遗留孤儿。
2. `packages/db/src/queries.ts`：`claimNextResumableTask` 去掉 `claude_session_id IS NOT NULL` 约束，终态
   任务（含 failed）有待消费回复即可认领。`resume_claimed` 锚点不变，防失败重领。
3. `apps/worker/src/executor.ts`：`resumeTask` 改为「有会话 resume 同一会话、无会话 fresh 重建 + 带用户补充
   全新执行」（新增 `freshReplyPrompt`），与 `retryFailedTask` 的 resume/fresh 分流一致。
4. `apps/console/app/ui/task-detail-session.tsx`：`terminalResumable` 不再要求会话非空；占位文案按是否有会话
   区分「续接同一会话」/「带补充重新执行」。
5. 文档同步：`packages/db/src/task-state.ts` 的 `REPLYABLE_TERMINAL_STATUSES` 注释更新。
6. `apps/worker/src/worktree.ts`：新增 `assertPathCleared`——`removeWorktree` 后若目录仍在（被别的进程真占用、
   删不掉），抛**明确可执行**错误（「被占用 → 重启 Worker」）而非让 `git worktree add` 抛晦涩的 `already exists`。
7. **`apps/worker/src/worktree.ts`（根因 1.c 的真正修复，关键）**：`rmWorktreeDir` 删除窗口内临时设
   `process.noAsar = true`，关掉 Electron 的 asar 集成 → `.asar` 当普通文件删、不被 Electron 缓存/映射自锁。
   这才让「重启 worker 后清理 rmSync 不再自锁」成立，是真正能让续接重试跑通的那一处。finally 复原；同步删除窗口
   不 require 自身代码，故打包版（自身在 app.asar）也安全；纯 Node 下该属性无副作用。

## 验证

| 用例 | 脚本 | 结果 |
| --- | --- | --- |
| recover/fresh 撞孤儿目录(含 node_modules)能重建、复用不丢未提交改动、已注册工作树 fresh 重建；**目录被进程占用→抛明确可执行错误（非 already exists）** | `scripts/verify-worktree-orphan.mts`（驱动真实 `ensureWorktree`/`removeWorktree`，16 断言，含子进程占目录的真实锁场景 E） | PASS |
| Node `rmSync` 能删 >260 长路径 + 只读的 node_modules 树（git remove 做不到） | 临时实测 | PASS |
| 真实孤儿目录锁主定位：`rmSync`→EBUSY、`rename`→Access Denied、Restart Manager→锁主=Worker 进程(pid 58096，且我的会话就挂在它下面) | 对真实 `worktree-2ee00794-...` 实测 | PASS |
| **真 Electron 复现+验证根因+修复**：默认 asar 集成→`rmSync` 删不掉含 `.asar` 的目录（ENOTEMPTY/复现自锁）；`process.noAsar=true`→删干净（修复生效） | `scripts/proof-electron-asar-lock/`（真 electron.exe 跑两次） | PASS |
| 无会话失败任务收到回复后被认领续接（+ 不回归、防重领） | `scripts/smoke-reply-no-session.mts`（ephemeral PG） | PASS |
| 原「停不下来」防重领行为不回归 | `scripts/smoke-resume-loop-stop.mts`（ephemeral PG） | PASS |
| `npm run typecheck` / `npm run build`（5 包，含 next build） | — | PASS |

跑法：

```powershell
npx tsx docs/acceptance/failed-task-retry-reply/scripts/verify-worktree-orphan.mts
node docs/acceptance/failed-task-retry-reply/scripts/proof-electron-asar-lock/run.mjs   # 真 Electron 复现+验证 noAsar 修复
node scripts/run-smoke-against-ephemeral.mjs docs/acceptance/failed-task-retry-reply/scripts/smoke-reply-no-session.mts
node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-resume-loop-stop.mts
# 只读诊断真实任务现场：node docs/acceptance/failed-task-retry-reply/scripts/diag-task.mjs [taskId]
```

## 部署说明 / 当前任务处置

与前几轮不同：这次的根因修复（根因 1.c，`process.noAsar`）部署后**重启一次即可自愈**，不再每轮复发。步骤：

1. 拉最新代码（合入本 PR）→ **重新构建** Worker（`npm run build` / 重新打包）。
2. **彻底重启 Worker 进程**：注意要真正杀掉那个 `npm run dev` 起的 `electron .` 进程（前几轮 pid 一直没变 =
   之前的「重启」并没杀到它）。确认仓库下没有遗留的 electron 进程后再启动新 Worker。
3. 重试 task 2ee00794：新 Worker 的清理 `rmSync` 已带 `process.noAsar=true`，删 worktree 内 electron asar 时
   不再被自锁 → 残留孤儿目录被删掉 → `git worktree add` 成功 → 任务继续。

为何前几轮「拉代码+重启」都没用：#149/#151 的清理 `rmSync` 仍在 Electron asar 集成下运行，**每个新 Worker 第一次
清理就把 electron asar 自锁**，与重试不重试、重启不重启无关。根因 1.c 的 `process.noAsar` 才真正打断这个自锁。
