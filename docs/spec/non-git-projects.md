# 支持非 Git 管理的项目（vcs='none'）

> 2026-06-23。让 ClaudeCenter 支持「不是 git 仓库的本地目录」作为项目：任务与实时对话都能在该目录里直接跑 Claude，
> 就地修改文件，没有分支 / commit / push / PR。开工前快照，不回头维护。

## 背景与动机

现状所有项目都强绑 git：建项目必填 `repo_url`；任务执行在 `git worktree` 里隔离、收尾 commit/push/建 PR；
实时对话在「只读 worktree」里检出 `origin/<branch>`。但很多本地目录并非 git 仓（脚本目录、文档库、临时工程），
用户希望也能让 Worker 在这些目录里跑任务 / 对话。

## 设计总览

- **项目维度新增 `vcs` 标志**：`'git'`（默认，行为不变）/ `'none'`（非 git 本地目录）。
- **Console 侧**：`vcs='none'` 时不要求 `repo_url`、不拉远程分支、任务表单隐藏分支 / 提交模式 / PR 选项、
  对话表单隐藏分支、不建 `project_repos` 子仓。
- **Worker 侧（执行真相）**：以 `localPath` 下是否存在 `.git` 作为运行时判定（`isGitRepo`）。非 git →
  直接在 `localPath` 里跑 `claude -p`（不建 worktree、不 fetch、不 commit/push/PR），任务成功收尾即 `success`、无 PR。
  git 项目路径完全不变。
- **为何 Worker 用运行时探测而非透传 `vcs`**：`.git` 存在与否才是「能不能做 git 操作」的 ground truth，
  零查询改动且健壮；正常配置下 Console 的 `vcs` 与 Worker 的 `.git` 探测必然一致。

## 数据模型（迁移 037_non_git_projects.sql）

- `projects.repo_url` 去掉 `NOT NULL`（非 git 项目存 `NULL`；原 `UNIQUE` 保留，PG 允许多个 `NULL`）。
- `projects` 新增 `vcs text NOT NULL DEFAULT 'git' CHECK (vcs IN ('git','none'))` + `COMMENT ON`。
- `project_repos` / `task_repos` schema 不变：**非 git 项目根本不建这些行**（`syncMainProjectRepo` 跳过非 git）。
- `conversations.branch` / `tasks.{base,work,target}_branch` 保持 `NOT NULL`：非 git 时写 `''` 占位。

## 代码改动

### packages/db
- `types.ts`：`Project.repo_url: string | null`、`Project.vcs: ProjectVcs`、新增 `ProjectVcs`。
- `queries.ts`：
  - `createProject`/`updateProject` 接受 `repoUrl: string | null` + `vcs`；仅 `vcs='git'` 时 `syncMainProjectRepo`。
  - `upsertWorkerProjectLink`：`repo_identity` 兜底 `input.repoUrl ?? project.repo_url ?? project.name`（非 git
    无 repo_url，避免 NOT NULL 违例）。
- `claimNextMergeCheckCandidate` 已要求 `pr_url IS NOT NULL` + 非空分支 → 非 git 任务天然被排除，无需改。

### apps/console
- `api/projects/route.ts` POST、`api/projects/[id]/route.ts` PATCH：按 `vcs` 决定是否要求 `repoUrl`。
- `api/projects/[id]/branches/route.ts`：非 git / 无 repo_url → 返回 `{ branches: [] }`，不 shell `git ls-remote`。
- `api/tasks/route.ts` POST：非 git 项目跳过 `project_repos`/`task_repos`，分支字段写 `''`。
- `api/conversations/route.ts` POST：非 git 项目允许空 `branch`。
- UI：`projects.tsx`（建项目选 vcs、非 git 隐藏 repo/分支字段 + 列表徽标 + 禁子仓）、
  `tasks-compose.tsx`（非 git 隐藏分支 / 提交模式 / 子仓区、跳过分支拉取）、
  `chat-thread.tsx`（非 git 隐藏分支字段）、`task-detail-overview.tsx`（非 git 任务显示「就地修改」而非空分支行）。

### apps/worker
- `worktree.ts`：导出 `isGitRepo(localPath)`。
- `executor.ts`：
  - prompt 构造（taskPrompt/resumePrompt/freshReplyPrompt/retryPrompt + anchor）加 `isGit`，非 git 用「项目目录」措辞。
  - `executeTask`/`resumeTask`/`retryFailedTask`：非 git → 不建 worktree、`cwd=localPath`、`ctxs=[]`、
    附件落 `localPath/.claude-attachments/`、`handleClaudeTurn(..., isGit=false)`。
  - `handleClaudeTurn` 加 `isGit`：auto_reply 的「有无改动」非 git 恒按有改动；收尾 git→`finalizeTaskMultiRepo`、
    非 git→`finalizeNonGitTask`（`markTaskSuccess` 无 PR）。
  - `executeConversationTurn`：非 git → `cwd=localPath` 直接跑，跳过 fetch/worktree。
- GC：`gcWorktrees` 对非 git 目录 `git worktree list` 失败被 catch → 天然 no-op，无需改。

## 边界 / 取舍

- **非 git 无并发隔离**：同一非 git 项目的并发任务都在 `localPath` 就地跑、会互相踩。git 的 worktree 隔离是 git 专属能力；
  非 git 接受此限制（用户要的就是「改我的本地目录」）。
- **`.claude-attachments/` 残留**：非 git 目录无 GC，附件目录会留在用户目录里（git 项目随 worktree GC 销毁）。可接受。
- **vcs 不可改**：建项目时定死，编辑不改 vcs（git↔none 切换会留下孤儿 project_repos/task_repos，刻意不支持）。

## 验证

- 五包 typecheck / build 绿。
- `npm run db:ephemeral` 跑到 037 成功；`projects` 有 `vcs` 列、`repo_url` 可空。
- `verify:console` 401→200、scheduler.ok。
- 手测：建 vcs=none 项目（不填 repo）；建任务 / 建对话不要求分支；DB 看 `tasks.work_branch=''`、无 `task_repos`。
- Worker 集成（headless，环境允许时）：非 git 目录跑任务 → 文件就地改、`success`、无 PR；跑对话 → 正常回复。
</content>
</invoke>
