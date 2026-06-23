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

→ **唯一解是重启 Worker**：释放句柄 + 加载已构建的新代码；重启后的新进程不再持锁，清理逻辑即可删掉残留目录、add 成功。

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
6. `apps/worker/src/worktree.ts`：新增 `assertPathCleared`——`removeWorktree` 后若目录仍在（被运行中的进程
   占用、删不掉，即根因 1.b 的 Worker 自锁），抛**明确可执行**错误（「被占用 → 重启 Worker」）而非让
   `git worktree add` 抛晦涩的 `already exists`，让 error_message 自带根因 + 处置，不再让人反复重试瞎猜。
   注意：这**不能**让锁存续期间的重试成功（删除逻辑对自锁无解），只把失败变得自解释；真正解除靠重启 Worker。

## 验证

| 用例 | 脚本 | 结果 |
| --- | --- | --- |
| recover/fresh 撞孤儿目录(含 node_modules)能重建、复用不丢未提交改动、已注册工作树 fresh 重建；**目录被进程占用→抛明确可执行错误（非 already exists）** | `scripts/verify-worktree-orphan.mts`（驱动真实 `ensureWorktree`/`removeWorktree`，16 断言，含子进程占目录的真实锁场景 E） | PASS |
| Node `rmSync` 能删 >260 长路径 + 只读的 node_modules 树（git remove 做不到） | 临时实测 | PASS |
| 真实孤儿目录锁主定位：`rmSync`→EBUSY、`rename`→Access Denied、Restart Manager→锁主=Worker 进程(pid 58096) | 对真实 `worktree-2ee00794-...` 实测 | PASS |
| 无会话失败任务收到回复后被认领续接（+ 不回归、防重领） | `scripts/smoke-reply-no-session.mts`（ephemeral PG） | PASS |
| 原「停不下来」防重领行为不回归 | `scripts/smoke-resume-loop-stop.mts`（ephemeral PG） | PASS |
| `npm run typecheck` / `npm run build`（5 包，含 next build） | — | PASS |

跑法：

```powershell
npx tsx docs/acceptance/failed-task-retry-reply/scripts/verify-worktree-orphan.mts
node scripts/run-smoke-against-ephemeral.mjs docs/acceptance/failed-task-retry-reply/scripts/smoke-reply-no-session.mts
node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-resume-loop-stop.mts
# 只读诊断真实任务现场：node docs/acceptance/failed-task-retry-reply/scripts/diag-task.mjs [taskId]
```

## 部署说明 / 当前任务处置（重要）

**必须重启 ClaudeCenter Worker**——这是 task 2ee00794 唯一的解，原因有二，且二者都靠「重启」一并解决：

1. **释放自锁**（根因 1.b）：运行中的 Worker 进程（electron，pid 58096）正持有残留孤儿目录
   `worktree-2ee00794-...\node_modules\electron\...\default_app.asar` 的 OS 句柄。只要它在跑，该目录就删不掉、
   改不了名 → `git worktree add` 永远 `already exists`。**已对真实目录验证：rmSync→EBUSY、rename→Access Denied、
   Restart Manager 确认锁主就是 Worker 本身**。代码层无法在锁存续期间解除，重启新进程才会释放句柄。
2. **加载新代码**：Worker 跑的是已构建代码，源码改了不自动生效。

重启后：新 Worker 进程不再持锁 → 下一次续接重试时 `removeWorktree` 的 Node 强删即可删掉残留孤儿目录 →
`worktree add` 成功 → 任务正常继续。若届时仍有别的进程占用，会得到 `assertPathCleared` 的明确报错（指明被占用、
该重启），而不再是晦涩的 `already exists`。
