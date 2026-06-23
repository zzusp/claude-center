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

## 验证

| 用例 | 脚本 | 结果 |
| --- | --- | --- |
| recover/fresh 撞孤儿目录(含 node_modules)能重建、复用不丢未提交改动、已注册工作树 fresh 重建（含 node_modules） | `scripts/verify-worktree-orphan.mts`（驱动真实 `ensureWorktree`/`removeWorktree`，12 断言） | PASS |
| Node `rmSync` 能删 >260 长路径 + 只读的 node_modules 树（git remove 做不到） | 临时实测 | PASS |
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

## 部署说明

worker 是常驻 Electron 桌面进程，用的是它**已构建/安装的代码**——本次修复需**重新构建并重启 worker** 才生效
（今早 00:25 / 00:27 仍报相同错误是因为跑的还是旧代码）。重启后续接重试会自愈：fresh 路径的 `removeWorktree`
会用 Node 强删把残留的 `worktree-2ee00794-...` 孤儿目录（含 node_modules）清掉，再 `worktree add` 即成功。
