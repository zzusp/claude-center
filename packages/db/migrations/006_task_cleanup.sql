-- 完成后清理 + merged 终态
-- 方案见 docs/spec/task-cleanup-merge.md
--
-- 复用 004 的 submit_mode（pr / push）作为投递模式，本迁移只补「完成后清理」缺的一环：
-- merged 终态 + PR 合并轮询游标 + 清理候选索引。

-- merge_checked_at: periodic 轮询 PR 合并状态的轮转游标，NULL 优先检查。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS merge_checked_at timestamptz;

-- tasks.status 增加 'merged'（PR 已合并并清理 / 直推 push 已落地）。沿用 003 起的全集 +merged。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('draft', 'pending', 'claimed', 'running', 'waiting', 'success', 'merged', 'failed', 'cancelled'));

-- 清理候选轮转索引：本 worker 的、已建 PR 的 success 任务，按 merge_checked_at 取最久未查的。
CREATE INDEX IF NOT EXISTS tasks_cleanup_idx
  ON tasks(claimed_by, merge_checked_at)
  WHERE status = 'success' AND pr_url IS NOT NULL;

-- 早期 003_task_cleanup.sql 曾引入 delivery_mode，现已统一到 004 的 submit_mode；存量库清掉它。
-- 全新库从未有该列，DROP IF EXISTS 为 no-op。
ALTER TABLE tasks DROP COLUMN IF EXISTS delivery_mode;
