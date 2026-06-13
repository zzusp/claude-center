-- 010_task_drop_priority_target_files.sql
-- 移除 tasks.priority / tasks.target_files 字段。
-- priority 原驱动认领队列排序（claimNextTask ORDER BY priority DESC），移除后队列退化为按 created_at FIFO；
--   tasks_queue_idx（001）含 priority 列，先删旧索引、删列后按 (status, created_at) 重建。
-- target_files 原决定 Worker finalizeTask 的 git add 范围，移除后恒定 git add --all。

DROP INDEX IF EXISTS tasks_queue_idx;

ALTER TABLE tasks DROP COLUMN IF EXISTS priority;
ALTER TABLE tasks DROP COLUMN IF EXISTS target_files;

CREATE INDEX IF NOT EXISTS tasks_queue_idx
  ON tasks(status, created_at)
  WHERE status = 'pending';
