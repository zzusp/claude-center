-- 签出分支 / PR 目标分支拆分 + 提交模式（PR 或直接 commit+push）
-- 方案见 docs/spec/task-branch-submit-mode.md

-- base_branch 语义收敛为「签出分支」（工作起点）。
-- 新增 target_branch：PR 模式下是 PR base，push 模式下是直接推送的目标分支。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_branch text NOT NULL DEFAULT 'main';
-- 存量任务：目标分支沿用签出分支，保持旧行为（PR base == 签出分支）。
UPDATE tasks SET target_branch = base_branch;

-- 提交模式：pr = 推送工作分支并开 PR；push = 直接 commit+push 到目标分支。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submit_mode text NOT NULL DEFAULT 'pr';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_submit_mode_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_submit_mode_check
  CHECK (submit_mode IN ('pr', 'push'));
