# 失败任务重试问题修复

## 症状

- 任务 `2ee00794-3e52-4ecb-88a9-be179eaf3b2a` 失败后**无法续接重试**：日志显示工作树（worktree）已存在，
  代码仍尝试新建，git 报 `fatal: '<path>' already exists`，重试每次都在 worktree 准备阶段就失败。
- 该任务**也无法通过对话补充信息继续**：任务详情的回复框对失败任务显示「任务非在途」并禁用，用户连一句
  补充都发不出去。

## 根因

### 根因 1：孤儿残留目录撞 `worktree add`（`apps/worker/src/worktree.ts`）

`ensureWorktree` 的两条路径在 `git worktree add` 前没有处理「目录已存在但不是有效/已注册工作树」的情形：

- recover（续接/重试，`fresh=false`）：仅 `existsSync(<wt>/.git)` 为真才复用。`.git` 文件丢失但目录残留
  （非空）时，`worktree prune` 会**清掉悬挂注册却保留目录**，随后 `worktree add` 撞 already exists。
- fresh（`fresh=true`）：`removeWorktree` 只能拆「已注册工作树」，对注册已丢的孤儿目录报 `not a working tree`
  （被容错吞掉），目录残留 → `worktree add` 撞 already exists。

git ground truth（实测 git 2.39.1）：`git worktree add --force` **不豁免**「目标目录已存在且非空」这一项；
要让 add 成功，必须先把孤儿目录删掉（空目录可直接 add）。

### 根因 2：失败任务无会话时不允许回复续接

- DB `claimNextResumableTask` 要求 `claude_session_id IS NOT NULL` 才认领终态任务——失败在 worktree 准备
  阶段时 Claude 还没产出 session，永远认领不到。
- Console 回复框 `terminalResumable` 同样要求 `Boolean(task.claude_session_id)`，失败任务（无会话）回复框
  被禁用并显示「任务非在途」。
- Worker `resumeTask` 直接 `throw` 当 `!claude_session_id`，没有「无会话则全新执行」的分支。

## 修复

1. `apps/worker/src/worktree.ts`：新增 `rmOrphanDir`，在 fresh 与 recover 两条路径的 `worktree add` 前兜底
   删掉孤儿残留目录（best-effort）。recover 仍优先复用有效工作树（`.git` 存在即返回，保住未提交改动）。
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
| recover/fresh 撞孤儿目录后能重建、复用不丢未提交改动 | `scripts/verify-worktree-orphan.mts`（驱动真实 `ensureWorktree`） | PASS |
| 无会话失败任务收到回复后被认领续接（+ 不回归、防重领） | `scripts/smoke-reply-no-session.mts`（ephemeral PG） | PASS |
| 原「停不下来」防重领行为不回归 | `scripts/smoke-resume-loop-stop.mts`（ephemeral PG） | PASS |
| `npm run typecheck` / `npm run build`（5 包，含 next build） | — | PASS |

跑法：

```powershell
npx tsx docs/acceptance/failed-task-retry-reply/scripts/verify-worktree-orphan.mts
node scripts/run-smoke-against-ephemeral.mjs docs/acceptance/failed-task-retry-reply/scripts/smoke-reply-no-session.mts
node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-resume-loop-stop.mts
```
