# 工作分支保护门（主仓分支不被任务静默改写）

## 需求

执行任务时不应该影响项目主仓的分支：发现某些任务把主仓分支签出/重置为自家开发分支，应改在自家 worktree 内做这类操作。

## 根因

`apps/worker/src/worktree.ts::ensureWorktree` 在 fresh 路径用 `git worktree add --force -B <workBranch> <wtPath> <baseRef>`：

- 当 `<workBranch>` 已存在但**无任何 worktree 持有**时（例：用户曾手动建过同名分支后切走），`-B` 会**静默重置**该分支到 `<baseRef>`，覆盖用户在该分支上的所有现有提交，且不可恢复。
- recover 路径用 `git worktree add --force <wtPath> <workBranch>`（无 `-B`）；当 `<workBranch>` 当前已被主仓 / 别人 worktree 持有时，`--force` 会**静默 dual checkout**，本任务后续 commit 会落到对方持有的分支上，污染主仓分支。
- 当 `<workBranch>` 当前被某 worktree 持有 且 用 `-B` 时，git 自带 fatal 保护——但报错语义晦涩，需更友好的错误。

## 改动

`apps/worker/src/worktree.ts`：
- 新增 `assertWorkBranchSafe(localPath, wtPath, workBranch)`（apps/worker/src/worktree.ts:139-210）。
- `ensureWorktree` 入口处先调用 `assertWorkBranchSafe`（apps/worker/src/worktree.ts:222）。

放行规则：
1. 自家 `wtPath` 当前持有该分支 → 允许（典型 retry / 复用）。
2. 自家 `wtPath` 已注册但 detach（无人持有该分支 ref + 分支可能仍存在）→ 允许（终态后续接路径）。
3. 分支不存在且无任何 worktree 持有 → 允许（新任务首轮）。

拒绝规则：
- 分支被「自家 wtPath 以外」的 worktree（含主仓自身）持有 → 抛错（含友好定位 + 修复建议）。
- 分支存在但无 worktree 持有，且本任务也无 wtPath 注册 → 抛错（避免 `-B` 静默重置或不带 `-B` dual checkout 污染）。

## 验证

- `node docs/acceptance/work-branch-safety/scripts/test-work-branch-safety.mjs` — 端到端覆盖 5 个场景（A 全新 / B 主仓持有 / C 既存无人持有 / D 自家 detach / E 自家持有）；全 PASS。
- `npm run typecheck` — 五包绿。
