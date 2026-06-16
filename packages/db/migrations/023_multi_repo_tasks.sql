-- 023_multi_repo_tasks.sql
-- 多仓任务（主仓 + 子仓清单）。方案见 docs/spec/task-multi-repo.md
--
-- 兼容策略：
-- - projects.repo_url / default_branch 视为主仓行(role='main')的镜像，老路径继续可用。
-- - tasks.base_branch / work_branch / target_branch / pr_url 视为 task_repos 主仓行的镜像；
--   单仓项目的 task_repos 仅一行(role='main')，循环 finalize 等价于老 finalizeTask。
-- - 不动 tasks_status_check（任务级状态机零改动，强语义聚合 → 见 spec 第 5 节）。
-- - 不引入 btree_gist 扩展：用 partial unique index 实现"同 project 只一个 main 行"。

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
  -- 主仓 '.'；子仓非空、不以 '/' 开头、不含反斜杠（POSIX 风格强制）
  CHECK (
    relative_path = '.'
    OR (length(relative_path) > 0 AND relative_path NOT LIKE '/%' AND position('\' in relative_path) = 0)
  ),
  -- 主仓 role 与路径必须一致：主仓行 relative_path 必须是 '.'，子仓行必须不是 '.'
  CHECK ((role = 'main' AND relative_path = '.') OR (role = 'sub' AND relative_path <> '.'))
);

-- 同 project 只允许一个主仓行（partial unique index 替代 EXCLUDE 约束，免依赖 btree_gist 扩展）。
CREATE UNIQUE INDEX IF NOT EXISTS project_repos_main_uniq
  ON project_repos(project_id)
  WHERE role = 'main';

CREATE INDEX IF NOT EXISTS project_repos_project_idx
  ON project_repos(project_id, position);

-- 主仓回填：为每个已存在的 project 自动生成一条 role='main' 的 project_repos 行。
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
  -- 子态：
  -- pending     待跑（任务尚未执行到该仓）
  -- no_changes  本轮无改动（git status 干净，跳过 commit/push/PR）
  -- committed   本轮已 commit（push 失败时停在此态）
  -- pushed      已 push（submit_mode=push 终态 / pr 模式 push 完待建 PR）
  -- pr_created  已 push + 建/复用 PR
  -- pr_merged   PR 已合并（auto_merge 或 Console 检测）
  -- skipped     用户在 UI 上取消启用本仓
  -- failed      本仓 commit/push/PR 失败（强语义 → 任务整体 failed）
  sub_status text NOT NULL DEFAULT 'pending'
    CHECK (sub_status IN (
      'pending','no_changes','committed','pushed','pr_created','pr_merged','skipped','failed'
    )),
  pr_url text,
  error_message text,
  -- 末次执行/状态翻转时间戳（finalize 单仓收尾后写）。
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, project_repo_id),
  UNIQUE(task_id, relative_path)
);

-- 同 task 只允许一个主仓行（同上：partial unique index）。
CREATE UNIQUE INDEX IF NOT EXISTS task_repos_main_uniq
  ON task_repos(task_id)
  WHERE role = 'main';

CREATE INDEX IF NOT EXISTS task_repos_task_idx ON task_repos(task_id);

-- 存量任务回填：为每个已存在的 task 生成一条主仓 task_repos 行，分支字段从 tasks 镜像。
-- sub_status 从 tasks.status 反推：进入终态/合并/已建 PR 的任务给对应已完成态；其余按 pending。
-- 这是「事后追认」式回填，仅用于让旧任务在新模型下表达自洽——不会回放任何 git 操作。
INSERT INTO task_repos (
  task_id, project_repo_id, role, relative_path,
  base_branch, work_branch, target_branch,
  sub_status, pr_url, last_sync_at
)
SELECT
  t.id,
  pr.id,
  'main',
  '.',
  t.base_branch,
  t.work_branch,
  t.target_branch,
  CASE
    WHEN t.status = 'merged' OR t.merge_status = 'merged' THEN 'pr_merged'
    WHEN t.pr_url IS NOT NULL THEN 'pr_created'
    WHEN t.status IN ('success','accepted','rejected') THEN 'pushed'
    WHEN t.status = 'failed' THEN 'failed'
    WHEN t.status = 'cancelled' THEN 'skipped'
    ELSE 'pending'
  END,
  t.pr_url,
  CASE WHEN t.finished_at IS NOT NULL THEN t.finished_at ELSE NULL END
FROM tasks t
JOIN project_repos pr ON pr.project_id = t.project_id AND pr.role = 'main'
ON CONFLICT (task_id, project_repo_id) DO NOTHING;
