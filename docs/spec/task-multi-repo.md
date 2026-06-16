# 多仓任务（主仓 + 子仓清单）

## 需求

1. 一个 Console 项目可能由 **主仓 + N 个独立 git 子仓** 组成，子仓物理上放在主仓目录下（**不**是 git submodule，是独立 `.git`），主仓的 `.gitignore` 已忽略子仓路径。
2. 单次任务可能 **同时改主仓和若干子仓** 的代码（典型场景：主仓引用子仓的新 API → 两边都得改）。
3. 任务对每个 **有改动的仓** 独立 `commit / push / gh pr create`，每仓一个 PR。
4. 任务整体状态需准确反映「全部 PR 成功 / 任一失败 / 全部 merged」，且续接 / 打回重跑 / 失败重试链路对每个仓都自洽。

## 现状（已读源码确认）

- 单仓模型在三处都是单值：
  - `projects(repo_url, default_branch)`（`packages/db/migrations/001_init.sql:8-17`）
  - `tasks(base_branch, work_branch, target_branch, pr_url, merge_status)`（`001_init.sql:44-63`、`004_task_target_branch.sql`、`011_task_merge_status.sql`）
  - `worker_project_links(local_path)` —— 每 worker 一份主仓本地 clone（`001_init.sql:32-42`）
- worker 执行四入口都假定 **一棵 worktree、一个 work_branch、一个 PR**：
  - `executeTask`（`executor.ts:531`）：`fetch origin` → `ensureWorktree(fresh:true, baseRef:origin/<base>)` → 跑 Claude → `finalizeTask`
  - `resumeTask`（`executor.ts:573`）：复用 worktree、同 session 续接
  - `rerunRejectedTask`（`executor.ts:620`）：`fetch origin` → 复用 worktree、同 session 续接；finalize 看 `task.pr_url` 跳过建 PR
  - `retryFailedTask`（`executor.ts:668`）：有 session 复用 / 无 session 重建
- `finalizeTask`（`executor.ts:396-528`）：单仓 `status → add → commit → push → [push 模式 markMerged | pr 模式 gh pr create → 可选 auto_merge]`
- 任务状态全集（12 态）：`draft / scheduled / pending / claimed / running / waiting / success / merged / accepted / rejected / failed / cancelled`（`migrations/001/002/003/006/007/009`）
- worktree 命名 + GC：`<localPath>/.claude/worktrees/worktree-<taskId>/`，GC 严格匹配 `worktree-<UUID>` 才清，dev slug 树 / 会话树不动（`worktree.ts:13-17, 104-135`）
- `markTaskSuccess / markTaskFailed / markTaskMerged` 都是 **task 级** 单值更新（`packages/db/src/queries.ts:957/978/1128`），没有"仓粒度子态"概念

## 关键设计抉择（已确认）

> 2026-06-16 三条已确认采用推荐方案。反向选项与取舍保留备查，便于未来痛点出现时回看。

### 抉择 1：状态机粒度 — ✅ 强语义

- **采用 — 强语义**：`tasks.status` 仍单值、状态机 **零改动**。任一仓 commit/push/PR 失败 → task 整体 `failed`；重试时所有仓 worktree 全部重建、所有 work_branch 强制重置到各自 `origin/<base>`。
  - 实现简单（沿用现有 finalize 错误分支）、状态机不动、UI 只多一个"子仓清单 + sub_status 展示"
  - 代价：一个子仓 push 失败 → 主仓已 commit 但 push 也回滚不了；下一轮重跑会 reuse worktree（含未提交改动），但失败仓的 work_branch 会被 reset
- **未采用 — 弱语义**：每仓独立 sub_status，task 支持 partial 状态（如 `partial_success`），重试只重做失败仓。
  - 实现量：状态机重设计 + queries 重写 + 重试入口分仓控制 + UI 复杂度上升一档
  - 体验更好但代价大，等明确成痛点（多仓失败重试在生产中频繁出现）再升

### 抉择 2：PR 自动合并策略 — ✅ 强一致

- **采用 — 强一致**：`auto_merge_pr` 开启时，先用 `gh pr view --json mergeable` 检查 **所有 PR** 都 mergeable 才统一 merge；任一不可合 → 全不合 + 告警事件。合并顺序按 `project_repos.position`，**子仓先合、主仓最后合**（主仓往往引用子仓新版本，反过来合可能撞 review CI）。
- **未采用 — best-effort**：逐个 `gh pr merge`，失败的告警不阻断。
  - 风险：可能出现"主仓合了、子仓没合"的不一致状态，回收成本远高于"全不合等人工"。

### 抉择 3：数据模型粒度 — ✅ 子表

- **采用 — 子表 `project_repos` + `task_repos`**：能加 unique 约束（task × repo 唯一）、能 join 查询、能加索引、回滚干净。
- **未采用 — `projects.sub_repos jsonb` + `tasks.repo_branches jsonb`**：灵活但难索引 / 统计，每次改字段都得改 jsonb schema。

## 数据模型（migration `023_multi_repo_tasks.sql`）

> 编号 023 在当前最高 022 之后。新建迁移前先 `git fetch` 看 `origin/main` 与各 `worktree-*` 已占用号；本约束重建沿用「列当前全集」规则。

```sql
-- 023_multi_repo_tasks.sql
-- 项目子仓清单与任务级仓快照。方案见 docs/spec/task-multi-repo.md
--
-- 兼容：projects.repo_url / default_branch 视为主仓行的镜像；tasks.base_branch /
-- work_branch / target_branch / pr_url 视为 task_repos 主仓行的镜像，老代码与
-- Console 单 PR 列表展示按主仓字段继续工作。

-- 项目仓清单：主仓也记一行(role='main', relative_path='.')，便于循环。
CREATE TABLE IF NOT EXISTS project_repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('main', 'sub')),
  -- 主仓 '.'；子仓为相对主仓的 POSIX 路径(如 'packages/widgets-lib')
  relative_path text NOT NULL,
  repo_url text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  display_name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, relative_path),
  -- 主仓 '.'，子仓非空且必须 POSIX 风格(不允许 '/' 开头或反斜杠)
  CHECK (
    relative_path = '.'
    OR (length(relative_path) > 0 AND relative_path NOT LIKE '/%' AND position('\' in relative_path) = 0)
  ),
  -- 同项目只允许一个主仓
  EXCLUDE (project_id WITH =) WHERE (role = 'main')
);

CREATE INDEX IF NOT EXISTS project_repos_project_idx
  ON project_repos(project_id, position);

-- 主仓回填：每个已存在的 project 自动生成一条 role='main' 的 project_repos 行。
INSERT INTO project_repos (project_id, role, relative_path, repo_url, default_branch, display_name, position)
SELECT id, 'main', '.', repo_url, default_branch, name, 0 FROM projects
ON CONFLICT (project_id, relative_path) DO NOTHING;

-- 任务级仓快照：每个仓在该任务上的 base/work/target 分支 + 子状态。
-- 任务创建时按 project_repos 全集生成行(用户在 UI 上可勾掉不启用 → sub_status='skipped')。
CREATE TABLE IF NOT EXISTS task_repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_repo_id uuid NOT NULL REFERENCES project_repos(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('main', 'sub')),
  relative_path text NOT NULL,
  base_branch text NOT NULL,
  work_branch text NOT NULL,
  target_branch text NOT NULL,
  -- 子态:pending(待跑)/no_changes(本轮无改动)/committed/pushed/pr_created/pr_merged
  --      /skipped(用户未启用)/failed
  sub_status text NOT NULL DEFAULT 'pending'
    CHECK (sub_status IN (
      'pending','no_changes','committed','pushed','pr_created','pr_merged','skipped','failed'
    )),
  pr_url text,
  error_message text,
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, project_repo_id),
  UNIQUE(task_id, relative_path),
  -- 同任务只允许一个主仓行
  EXCLUDE (task_id WITH =) WHERE (role = 'main')
);

CREATE INDEX IF NOT EXISTS task_repos_task_idx ON task_repos(task_id);

-- 存量任务回填：为每个已存在的 task 生成一条主仓 task_repos 行，分支字段从 tasks 镜像。
INSERT INTO task_repos (task_id, project_repo_id, role, relative_path, base_branch, work_branch, target_branch, sub_status, pr_url)
SELECT
  t.id,
  pr.id,
  'main',
  '.',
  t.base_branch,
  t.work_branch,
  t.target_branch,
  CASE
    WHEN t.status IN ('merged') THEN 'pr_merged'
    WHEN t.pr_url IS NOT NULL THEN 'pr_created'
    WHEN t.status IN ('success','accepted','rejected') THEN 'pushed'
    ELSE 'pending'
  END,
  t.pr_url
FROM tasks t
JOIN project_repos pr ON pr.project_id = t.project_id AND pr.role = 'main'
ON CONFLICT (task_id, project_repo_id) DO NOTHING;
```

> 设计要点：
> - `EXCLUDE (project_id WITH =) WHERE (role='main')` 用 btree exclusion 约束保证 "一项目只能一个主仓行"；`task_repos` 同。
> - `tasks` 表 **不动 schema**，老字段视作主仓镜像。新代码读 task_repos，老代码读 tasks 镜像 —— 单仓任务行为完全不变（`task_repos` 只有一行 main）。
> - `project_repos.repo_url` 与 `projects.repo_url` 主仓行始终保持一致；同步在 Console 编辑层兜底（双写 + 校验）。

### 子仓在 worker 上的本地路径

约定 `<mainLocal>/<relative_path>`（与项目结构一致，主仓 .gitignore 已忽略）。**不**新建表：

- worker 首次执行任务时探测 `<mainLocal>/<relative_path>/.git`：
  - 存在 → 直接 `git -C <localRepo> fetch origin`
  - 不存在 → `git clone <project_repos.repo_url> <mainLocal>/<relative_path>`；clone 失败 → 该仓 sub_status='failed' → 整任务 failed（按强语义）

## 状态机

**任务级状态全集不变**（12 态），无新增。`success / failed / merged / accepted / rejected` 语义按"全部参与仓"的聚合解读：

| task 状态 | 多仓含义 |
|---|---|
| `success` | 所有参与仓 sub_status ∈ {pushed, pr_created, no_changes}，至少一仓有改动 |
| `failed` | 至少一仓 sub_status='failed'（强语义） |
| `merged` | submit_mode='push' 且所有参与仓 sub_status='pushed' |
| `accepted` | 所有 pr_created 仓的 PR 都被合 + Console 检查通过 |
| `rejected` | 用户在 Console 打回 |
| `cancelled` / `failed` | Claude 进程被取消 / Claude 报错 |

`merge_status` 仍 task 级（unknown / unmerged / merged）：定时检查时**所有 task_repos 的 pr_url 都已合**才置 merged，任一未合 → unmerged。

## 工作树布局

- 主仓 worktree：`<mainLocal>/.claude/worktrees/worktree-<taskId>/`（**不变**）
- 子仓 worktree：`<mainLocal>/.claude/worktrees/worktree-<taskId>/<sub_relative_path>/` —— **原位嫁接** 到主 worktree 内对应子目录

实施：

```ts
// 1. 主仓
await runCommand("git", ["-C", mainLocal, "fetch", "origin"]);
await ensureWorktree(mainLocal, wtPath, {
  workBranch: mainTaskRepo.work_branch,
  baseRef: `origin/${mainTaskRepo.base_branch}`,
  fresh: true
});

// 2. 每个子仓
for (const tr of subTaskRepos) {
  const subLocal = path.join(mainLocal, tr.relative_path);
  await ensureSubRepoCloned(subLocal, tr.repo_url);             // 新增工具:不存在则 clone
  await assertIgnoredInMain(mainLocal, tr.relative_path);       // 新增工具:必须被主仓忽略,否则报错
  await runCommand("git", ["-C", subLocal, "fetch", "origin"]);
  await ensureWorktree(subLocal, path.join(wtPath, tr.relative_path), {
    workBranch: tr.work_branch,
    baseRef: `origin/${tr.base_branch}`,
    fresh: true
  });
}
```

**前置硬约束**：主仓 `.gitignore` 必须忽略子仓 `relative_path`，否则主仓 worktree add 出来该路径就是空目录或被主仓占用，子仓 worktree add 会撞 `'<path>' already exists`。`assertIgnoredInMain` 通过 `git -C <mainLocal> check-ignore -q <rel>` 探测，未命中则 emit `multi_repo_misconfigured` 事件 + 抛错 + 任务 failed —— **不静默 workaround**（遵循硬线 8「遇阻不绕路」）。

Claude cwd 仍为主 wtPath，子仓代码在原相对路径上，Claude 无感知多仓存在。

## 任务执行流程

### 新任务 `executeTask`（多仓版）

```ts
async function executeTask(config, task, hooks) {
  await markTaskRunning(...);
  const localPath = await getTaskLocalPath(...);                // 主仓 local_path
  const taskRepos = await getTaskRepos(pool, task.id);          // 按 position 排序,main first
  const wtPath = worktreePathFor(localPath, task.id);

  // 1. 为每个参与仓签出 worktree(skipped 仓跳过)
  for (const tr of taskRepos) {
    if (tr.sub_status === 'skipped') continue;
    const repoLocal = tr.role === 'main' ? localPath : path.join(localPath, tr.relative_path);
    const repoWt    = tr.role === 'main' ? wtPath    : path.join(wtPath, tr.relative_path);
    if (tr.role === 'sub') {
      await ensureSubRepoCloned(repoLocal, tr.repo_url);
      await assertIgnoredInMain(localPath, tr.relative_path);
    }
    await runCommand("git", ["-C", repoLocal, "fetch", "origin"]);
    await ensureWorktree(repoLocal, repoWt, {
      workBranch: tr.work_branch,
      baseRef: `origin/${tr.base_branch}`,
      fresh: true
    });
    await addTaskEvent(pool, task.id, config.workerId, "worktree_prepared",
      `${tr.role === 'main' ? '主仓' : tr.relative_path} 工作树就绪`,
      { repoRole: tr.role, relativePath: tr.relative_path, workBranch: tr.work_branch, fresh: true });
  }

  // 2. 跑 Claude(cwd=主 wtPath,session 单一)
  const turn = await runTaskClaude(config, task.id, {
    prompt: taskPrompt(task, taskRepos), cwd: wtPath, model: task.model,
    onSpawn: hooks?.onClaudeSpawn
  });

  // 3. 多仓 finalize
  await finalizeTaskMultiRepo(config, task, taskRepos, localPath, wtPath, turn.result);
}
```

### `resumeTask` / `rerunRejectedTask`（多仓）

- 每个参与仓 `ensureWorktree({ fresh: false })`；某棵被 GC → 按 `work_branch` 重建（沿用现有 `worktree.ts` 行为）
- `rerunRejectedTask` 中每仓独立判断 `task_repos.pr_url` 是否存在 → 已存则该仓 finalize 时跳过 `gh pr create`（仅 push 更新已存 PR）

### `retryFailedTask`（多仓）

- 有 `claude_session_id` → 所有 worktree 复用（含未提交改动）
- 无 session → 所有仓 `fresh:true` + 已有 `task_repos.pr_url` 的仓 **先 `gh pr close --delete-branch`**（防僵尸 PR），然后清 `task_repos.pr_url`

## finalize 多仓流程

```ts
async function finalizeTaskMultiRepo(config, task, taskRepos, mainLocal, wtPath, claudeOutput) {
  const pool = getPool();
  const results = [];

  // 逐仓 commit/push/PR;每仓独立 try/catch(强语义下任一失败 → 整任务 failed,
  // 但仍要把已成功仓的 sub_status 落库,便于排查 + 下次重试不重做)。
  for (const tr of taskRepos) {
    if (tr.sub_status === 'skipped') {
      results.push({ tr, sub: 'skipped' });
      continue;
    }
    const subWt = tr.role === 'main' ? wtPath : path.join(wtPath, tr.relative_path);
    try {
      const status = await runCommand("git", ["-C", subWt, "status", "--porcelain"], { timeoutMs: 60_000 });
      if (!status.stdout.trim()) {
        await updateTaskRepoStatus(pool, tr.id, 'no_changes');
        results.push({ tr, sub: 'no_changes' });
        continue;
      }
      await runCommand("git", ["-C", subWt, "add", "--all"]);
      // 沿用 --no-verify(同 executor.ts:421 的理由)
      await runCommand("git", ["-C", subWt, "commit", "--no-verify", "-m", multiRepoCommitMsg(task, tr)]);
      await updateTaskRepoStatus(pool, tr.id, 'committed');

      if (task.submit_mode === "push") {
        await runCommand("git", ["-C", subWt, "push", "origin", `${tr.work_branch}:${tr.target_branch}`]);
        await updateTaskRepoStatus(pool, tr.id, 'pushed');
        results.push({ tr, sub: 'pushed' });
        continue;
      }
      await runCommand("git", ["-C", subWt, "push", "-u", "origin", tr.work_branch]);
      if (tr.pr_url) {
        // 打回重跑:已有 PR,push 自动更新
        await updateTaskRepoStatus(pool, tr.id, 'pr_created');
        results.push({ tr, sub: 'pr_created', prUrl: tr.pr_url, reused: true });
        continue;
      }
      const pr = await runCommand(config.ghCommand, [
        "pr", "create",
        "--base", tr.target_branch,
        "--head", tr.work_branch,
        "--title", multiRepoPrTitle(task, tr),
        "--body",  multiRepoPrBody(task, tr, claudeOutput, taskRepos)
      ], { cwd: subWt });
      const prUrl = extractPrUrl(`${pr.stdout}\n${pr.stderr}`);
      await updateTaskRepoPrUrl(pool, tr.id, prUrl);
      await updateTaskRepoStatus(pool, tr.id, 'pr_created');
      await addTaskEvent(pool, task.id, config.workerId, "pr_created",
        `${tr.role === 'main' ? '主仓' : tr.relative_path} PR 已建`,
        { repoRole: tr.role, relativePath: tr.relative_path, prUrl });
      results.push({ tr, sub: 'pr_created', prUrl });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateTaskRepoStatus(pool, tr.id, 'failed', msg);
      results.push({ tr, sub: 'failed', error: msg });
    }
  }

  // 强语义聚合
  const failures = results.filter(r => r.sub === 'failed');
  if (failures.length) {
    const summary = failures.map(f => `${f.tr.relative_path}: ${f.error}`).join('\n');
    await markTaskFailed(pool, task.id, config.workerId, summary, {
      workdir: wtPath, multiRepo: results
    });
    return;
  }

  const mainResult = results.find(r => r.tr.role === 'main');
  if (task.submit_mode === 'push') {
    await markTaskMerged(pool, task.id, config.workerId, { workdir: wtPath, multiRepo: results });
    for (const tr of taskRepos.filter(t => t.sub_status !== 'skipped')) {
      const repoLocal = tr.role === 'main' ? mainLocal : path.join(mainLocal, tr.relative_path);
      const repoWt    = tr.role === 'main' ? wtPath    : path.join(wtPath, tr.relative_path);
      await removeWorktree(repoLocal, repoWt);
    }
    return;
  }

  // submit_mode='pr':task.pr_url 取主仓 PR(向后兼容 Console 单 PR 列表)。
  await markTaskSuccess(pool, task.id, config.workerId, {
    workdir: wtPath, multiRepo: results
  }, mainResult?.prUrl ?? null);

  // 强一致自动合并
  if (task.auto_merge_pr) {
    await tryAutoMergeAllOrNone(config, task, results);
  }
}

async function tryAutoMergeAllOrNone(config, task, results) {
  const prResults = results.filter(r => r.sub === 'pr_created');
  if (!prResults.length) return;

  const mergeable = await Promise.all(prResults.map(async r => {
    try {
      const view = await runCommand(config.ghCommand,
        ["pr", "view", r.prUrl, "--json", "mergeable,mergeStateStatus"], { timeoutMs: 60_000 });
      const json = JSON.parse(view.stdout);
      return { r, ok: json.mergeable === 'MERGEABLE' && json.mergeStateStatus === 'CLEAN' };
    } catch (e) {
      return { r, ok: false, detail: String(e) };
    }
  }));
  const notMergeable = mergeable.filter(m => !m.ok);
  if (notMergeable.length) {
    await addTaskEvent(pool, task.id, config.workerId, "auto_merge_skipped",
      `${notMergeable.length}/${mergeable.length} 个 PR 不可合并,按强一致策略全部跳过自动合并`,
      { notMergeable: notMergeable.map(m => ({ relativePath: m.r.tr.relative_path, detail: m.detail })) });
    return;
  }
  // 子仓先合,主仓最后:按 position 升序;main 的 position=0(我们约定主仓 position 改为最大)
  // 或保持 position=0 + 在这里手动 sub-first 排序
  const order = [...prResults].sort((a, b) => {
    if (a.tr.role === b.tr.role) return 0;
    return a.tr.role === 'sub' ? -1 : 1;
  });
  for (const r of order) {
    try {
      await runCommand(config.ghCommand, ["pr", "merge", r.prUrl, "--merge"], { timeoutMs: 10 * 60_000 });
      await updateTaskRepoStatus(pool, r.tr.id, 'pr_merged');
      await addTaskEvent(pool, task.id, config.workerId, "auto_merged",
        `${r.tr.role === 'main' ? '主仓' : r.tr.relative_path} PR 已自动合并`, { prUrl: r.prUrl });
    } catch (e) {
      await addTaskEvent(pool, task.id, config.workerId, "auto_merge_failed",
        `${r.tr.relative_path}: ${String(e)}`, { prUrl: r.prUrl });
      // 已合的仓不回滚(没法回滚),保留 task 为 success 等人工处理
    }
  }
}
```

### commit / PR 文案

- `multiRepoCommitMsg(task, tr)`：单仓时 `ClaudeCenter task: ${task.title}`（同现有）；多仓时 `ClaudeCenter task: ${task.title} (${tr.role === 'main' ? 'main' : tr.relative_path})`。
- `multiRepoPrTitle(task, tr)`：单仓时 `task.title`；多仓时 `${task.title} [${tr.role === 'main' ? 'main' : tr.relative_path}]`，让 reviewer 一眼分辨。
- `multiRepoPrBody(task, tr, claudeOutput, taskRepos)`：在原 `prBody` 之上追加 "本任务涉及的其他仓 PR" 区段，列出其它仓的 `relative_path + pr_url`（创建时序：主仓 PR 内可能拿不到子仓 PR URL → finalize 完后再一次性 `gh pr edit --body` 回填，或主仓放最后建）。

## Console UI 改动

### 项目编辑页

- 新增 **"子仓清单"** 表格：每行 `relative_path / repo_url / default_branch / display_name / position`，增删改。
- 保存前校验：
  - `relative_path` POSIX 风格、唯一、非 `.`
  - `repo_url` 必填且与主仓不同
  - 提示用户 "本子仓路径必须在主仓 `.gitignore` 中忽略，否则任务执行会失败"
- 新增 `GET/PUT /api/projects/[id]/repos` 路由。

### 任务创建表单

- 默认基于项目 `project_repos` 全集生成 `task_repos` 草稿行
- 每行展示：仓显示名 + base / work / target 三个分支选择器（base / target 复用现有 `/api/projects/[id]/branches?repo=<id>` 扩展支持多仓）+ "在本任务启用" 开关（关 → `sub_status='skipped'`）
- 提交模式 / model / 标题 / 描述仍 task 级共享

### 任务详情概览

- 把单 PR 那一栏改成 **"多仓 PR 表格"**，每行：`仓 / sub_status / PR URL / 错误`
- 老的 `task.pr_url`（主仓 PR）单独再展示一次（兼容 webhook / 复制链接习惯）
- 时间线条目按 payload 里的 `repoRole / relativePath` 加前缀标签

### 列表 / 筛选

- 列表 "PR" 列仍展示 `task.pr_url`（主仓 PR）；新增 "多仓" 标签（task_repos 行数>1 时）
- 不新增筛选维度（MVP）

## GC 与并发

- `gcWorktrees`：扩展为遍历当前 worker 链接的所有项目仓（含子仓 local），对每个仓 repo 各跑一次 `git -C <localRepo> worktree list --porcelain`，按命名 `worktree-<UUID>` 清。`keepTaskIds` 仍按 task 维度（task 在终态外即保留所有仓 worktree）。
- 并发：worktree 命名 `worktree-<taskId>` 在每个仓内唯一，仓间不冲突；同项目并发任务通过 task 命名互斥。
- 子仓 `.gitignore` 保证主仓 worktree 的 `git status` 不被子仓改动污染（这是设计前提）。

## 边界场景与异常处理

| 场景 | 处理 |
|---|---|
| 子仓本地未 clone | worker 首次 ensure 时 `git clone`，失败则该仓 `sub_status='failed'` → task failed |
| 主仓 `.gitignore` 漏配子仓路径 | `assertIgnoredInMain` 探测失败，emit `multi_repo_misconfigured` 事件 + 抛错 + task failed（不静默 workaround） |
| 子仓在 `task_repos` 中被 skipped | 不签出该子仓 worktree、不参与 finalize；Claude 在主 wtPath 看不到该子仓代码（目录缺失） |
| Claude 在 skipped 仓里改了文件 | finalize 时 `git status` 在该路径看不到（子仓 worktree 没签出），改动落到主 worktree 里的空目录 → 主仓 worktree 的 `git status` 会把这堆未跟踪文件列出，但主仓 `.gitignore` 忽略了该路径 → `add --all` 不会带它们入 commit，silently 丢失。**需在 prompt 规则里明确禁止**（`prompts/center-rules.md` 加入 "未启用的仓路径下不可改文件"） |
| 某仓 PR 已 merge、另一仓 push 失败 → task failed | 已合 PR 无法回滚；task 标 failed 但已合 PR 保留，错误信息明确列出"X 仓已合 / Y 仓失败需人工处理" |
| 多仓 PR 之间 review 顺序 | 主仓 PR body 自动附"本任务涉及的其他仓 PR"列表，方便 reviewer 跳转 |
| Console 合并检查 | 现有 `mergeStatusCheck` 逻辑改成：对 `task_repos` 中所有 `pr_url IS NOT NULL` 的行各 `gh pr view`，全为 merged 才置 `task.merge_status='merged'`；任一未合 → `unmerged` |
| `submit_mode='push'` 多仓 | 每仓独立 push 到各自 target_branch；全部成功 → markMerged（一致语义） |
| 项目添加 / 删除子仓后老任务 | 老任务的 `task_repos` 行已固化，不受项目层增删影响（只影响新任务） |

## 迁移与兼容

- migration `023_multi_repo_tasks.sql` 同时回填：每个 project → 一条 `project_repos` 主仓行；每个已有 task → 一条 `task_repos` 主仓行。
- worker 侧 finalize 走"多仓路径"无条件（即便单仓项目也走循环 task_repos —— 循环只跑 1 次，行为等价于老 finalize）。
- 老的 `executor.ts:finalizeTask` 整段被 `finalizeTaskMultiRepo` 替换；`executeTask / resumeTask / rerunRejectedTask / retryFailedTask` 四入口的 worktree ensure 段改为循环 task_repos。
- `tasks.base_branch / work_branch / target_branch / pr_url` 不动 schema；新代码在 task 创建 / finalize 时**双写**主仓行 + tasks 镜像列，保证 Console 列表 / API / merge_status_check 等老路径继续工作。
- 回滚路径：删 `project_repos / task_repos` 两表，tasks 老字段仍是真值，等价回到单仓世界。

## 实施分期

### P1 — 最小可跑（约 1-2 周）

- migration 023（含主仓 + 老任务回填）
- queries：`getProjectRepos / upsertProjectRepo / getTaskRepos / createTaskRepos / updateTaskRepoStatus / updateTaskRepoPrUrl`
- worker `worktree.ts`：保留 `ensureWorktree` 单仓接口不变；新增 `ensureSubRepoCloned / assertIgnoredInMain`
- worker `executor.ts`：四入口循环 task_repos 签出；`finalizeTaskMultiRepo` 替换老 finalize
- Console：项目编辑页子仓表格 + 任务创建表单子仓分支选择器（基础版）
- 任务详情概览：多仓 PR 表格（基础版）
- 验收：单仓任务行为完全不变；新建多仓任务能成功跑出 N 个 PR；任一仓失败任务整体 failed

### P2 — 完善（约 1 周）

- 强一致自动合并（`tryAutoMergeAllOrNone`）
- 时间线按仓分组 / 标签
- worker 启动时探测项目所有 worker_project_link 的子仓 `.gitignore` 配置，配错的发警告事件
- `merge_status_check` 多 PR 聚合（任一未合 → unmerged）
- 主仓 PR body 自动追加 "本任务涉及其他仓 PR" 列表

### P3 — 可选 / 视使用情况

- 弱语义升级（partial 状态 + 分仓重试） —— 仅在 P1/P2 上线后多仓失败重试的痛点真实存在时再做
- PR 关闭 / 重开 / 重新触发的细粒度操作
- 子仓 / 主仓提交顺序的自定义依赖图（默认子仓先 / 主仓后已够用）

## 验证矩阵（建议 acceptance）

按项目验证规范，重型场景建议建 `docs/acceptance/task-multi-repo/`，`matrix.csv` 用例至少覆盖：

| 用例 | 期望 |
|---|---|
| 单仓项目新任务 | 行为完全等同改造前（task_repos 1 行） |
| 多仓项目新任务，仅主仓改动 | task success，仅主仓 PR；子仓 `sub_status='no_changes'` |
| 多仓项目新任务，主仓+子仓都改 | task success，N 个 PR；每个 PR body 互相引用 |
| 子仓 push 失败（远程权限） | task failed，已成功仓的 sub_status 仍落库；retry 后所有仓重建 |
| 主仓 `.gitignore` 漏配子仓路径 | 任务 failed + `multi_repo_misconfigured` 事件；配好后重跑通过 |
| 子仓本地未 clone | worker 自动 clone；失败则 task failed |
| 打回重跑 | 每仓独立判断是否复用 PR；不重复建 PR |
| `auto_merge_pr` + 所有 PR 都 mergeable | 子仓先合、主仓后合 |
| `auto_merge_pr` + 任一 PR 不可合 | 全不合 + `auto_merge_skipped` 事件 |
| 任务在 skipped 仓内改了文件 | 主仓 `add --all` 不带入（.gitignore 拦截）；prompt 规则提醒；time-line 给 warning |
| `submit_mode='push'` 多仓 | 每仓 push 到 target；全部成功 → markMerged |
