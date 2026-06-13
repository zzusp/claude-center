-- 011_task_merge_status.sql
-- Console 定时合并检查 + 自动验收
-- 方案见 docs/spec/task-merge-status-check.md
--
-- 在 Worker 侧 PR 合并清理（success → merged）之外，新增 Console 侧定时检查「work_branch 是否
-- 已合并进 target_branch」的能力：新增 merge_status 字段（任务列表可筛选 / 展示），检测到已合并时
-- 由 Console 把 success 任务自动转 accepted。

-- 合并状态：unknown 未检查 / unmerged 未合并 / merged 已合并。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS merge_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_merge_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_merge_status_check
  CHECK (merge_status IN ('unknown', 'unmerged', 'merged'));

-- merge_status_checked_at: Console 侧合并检查的轮转游标（NULL 优先），独立于 Worker 的
-- merge_checked_at（006），两侧互不干扰。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS merge_status_checked_at timestamptz;

-- 回填：Worker 已转 merged 终态的存量任务，合并状态即为 merged，保证筛选/展示一致。
UPDATE tasks SET merge_status = 'merged' WHERE status = 'merged' AND merge_status <> 'merged';

-- Console 轮转索引：success 待验收任务按 merge_status_checked_at 取最久未查的一个。
CREATE INDEX IF NOT EXISTS tasks_merge_check_idx
  ON tasks(merge_status_checked_at)
  WHERE status = 'success';
