# Console 定时合并检查 + 自动验收

## 需求

Web 端（Console）定时检查任务的「开发分支（work_branch）是否已合并进目标分支（target_branch）」，
任务上新增「合并状态」字段，任务流列表支持按合并状态筛选；一旦检测到已合并，自动把任务状态置为「已验收（accepted）」。

## 现状（改前）

- 合并检测此前**只在 Worker 侧**：`apps/worker/src/executor.ts:cleanupMergedTask` 用 `gh pr view <pr_url> --json state` 判
  `state==='MERGED'`，命中后删本地/远端 work 分支并把任务转入 **`merged`** 终态。依赖 Worker 在线 + 本地工作树。
- Console 侧定时器（`apps/console/instrumentation.ts`）此前只做 `scheduled → pending` 提升。
- Console 只装 git、不装 gh（`.env.example` 标注 `GH_COMMAND` 为 Worker only），已有 `git ls-remote`（`branches/route.ts`）。
- 任务状态枚举已含 `accepted`（已验收）。列表筛选在 `listTasks`（`packages/db/src/queries.ts`）+ `GET /api/tasks` + `dashboard.tsx`。

## 决策（已与用户确认）

1. **合并检测方式 = gh 优先 + git 祖先回退**：有 `pr_url` 先用 `gh pr view --json state` 判 `MERGED`；
   无 `pr_url` 或 gh 调用失败时，回退到远程 git 祖先判定（`merge-base --is-ancestor work target`）。
   git 回退复用 Console 现有 git/凭据能力，使 Console 无 gh 登录态时仍可工作。
   局限：git 回退对 squash/rebase 合并检测不到（原 commit 不进目标分支）——这类场景靠 gh 路径覆盖。
2. **自动验收范围 = 仅 `success`（已完成·待验收）工作任务**：检测到合并 → `accepted`。
   QA 任务（无分支）与其它状态不参与。Worker 已转 `merged` 的任务（status≠success）不受影响。

## 改动

### 1. DB 迁移 `011_task_merge_status.sql`
- `tasks.merge_status text NOT NULL DEFAULT 'unknown'` CHECK in (`unknown`,`unmerged`,`merged`)。
- `tasks.merge_status_checked_at timestamptz`：**Console 侧**轮转游标，独立于 Worker 的 `merge_checked_at`，互不干扰。
- 回填：`status='merged'` 的存量任务 `merge_status='merged'`（已合并）。
- 部分索引 `tasks_merge_check_idx ON tasks(merge_status_checked_at) WHERE status='success'`，支撑 Console 轮转取最久未查。
- 不动 `tasks_status_check`（只加新列，不引入新 status 值）。

### 2. 类型 `packages/db/src/types.ts`
- `MergeStatus = 'unknown'|'unmerged'|'merged'`；`Task` 加 `merge_status`、`merge_status_checked_at`。

### 3. 查询 `packages/db/src/queries.ts`
- `ListTasksFilters` 加 `mergeStatus?: string[]`；`listTasks` 加 `merge_status = ANY(...)` 条件。
- `claimNextMergeCheckCandidate(client)`：取一个 `status='success' AND task_type='work' AND work_branch<>'' AND target_branch<>''`
  的任务（join `projects.repo_url`），按 `merge_status_checked_at ASC NULLS FIRST` 轮转。
- `markTaskMergeAccepted(client, taskId)`：`WHERE id=$1 AND status='success'` 原子置 `status='accepted'`、`merge_status='merged'`、
  `merge_status_checked_at=now()`、`updated_at=now()`，落 `merge_accepted` 事件。
- `setTaskMergeUnmerged(client, taskId)`：置 `merge_status='unmerged'`、`merge_status_checked_at=now()`；
  **不动 updated_at**（避免每次轮询把 success 任务顶到列表顶部）。

### 4. Console 检测助手 `apps/console/app/lib/merge-check.ts`
- `detectBranchMerged({repoUrl, prUrl, workBranch, targetBranch, ghCommand})`：
  - 有 `prUrl` → `gh pr view <prUrl> --json state` → `state==='MERGED'`；gh 出错 → 落回 git 祖先。
  - git 祖先：临时 bare 仓 fetch work/target 两 ref，`merge-base --is-ancestor` exit0 即已合并；任何异常 → 视为未合并（不抛）。
  - 全程 `GIT_TERMINAL_PROMPT=0` + timeout + windowsHide，复用 `branches/route.ts` 同款执法。

### 5. 调度器 `apps/console/instrumentation.ts`
- 在原 promotion 循环外，新增独立的合并检查循环（默认 60s，env `CLAUDE_CENTER_MERGE_CHECK_INTERVAL_MS`，比 Worker 轮询慢，
  让在线 Worker 优先完成 `merged` + 分支清理；Worker 离线时 Console 兜底自动验收）。非重入。每轮取 1 个候选检测。

### 6. API `apps/console/app/api/tasks/route.ts`
- 解析 `mergeStatus` 查询参（逗号分隔，白名单 `unknown`/`unmerged`/`merged`），传入 `listTasks`。

### 7. 前端 `dashboard.tsx` + `shared.tsx`
- `shared.tsx`：`MERGE_STATUS_META` + `MergeStatusBadge`（未知/未合并/已合并）。
- `dashboard.tsx`：toolbar 加「合并状态」`Select` 筛选 + URL 参数 `mergeStatus`；表格加「合并」列展示。

## 已知交互 / 取舍
- Console 自动验收 **不做分支清理**（无本地工作树）。若 Console 在 Worker 之前赢得检测，work 分支可能残留在远端——
  故 Console 间隔（60s）刻意慢于 Worker 轮询（默认 10s），在线 Worker 通常先转 `merged` 并清理；Console 仅兜底离线场景。
- 两侧检测都以 `status='success'` 为门，谁先翻态另一侧自动落空，无双写冲突。

## 验证
- typecheck（db/console/worker）+ console build。
- 迁移 011 应用到 dev 库 + 查询冒烟（候选选取 / mergeStatus 筛选 / 自动验收翻态）。
- git 祖先判定对真实仓库（本仓 merged 分支 vs main）冒烟。
