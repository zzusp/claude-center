-- 任务发布门禁：新增 'draft'（草稿/待发布）初始态
-- 方案见 docs/spec/task-draft-gating.md
--
-- 新建任务落 'draft'，Worker 不认领；人工在 Console 发布（draft → pending）后才进入
-- 可认领队列。不改动 'pending' 语义，claimNextTask 仍只捞 'pending'，门禁自动生效。

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('draft', 'pending', 'claimed', 'running', 'waiting', 'success', 'failed', 'cancelled'));

ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'draft';
