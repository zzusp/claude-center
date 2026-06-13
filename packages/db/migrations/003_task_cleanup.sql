-- 任务完成后清理 + 直推模式 + merged 终态
-- 方案见 docs/spec/task-cleanup-merge.md

-- delivery_mode: 'pr'(默认,开 PR 等合并后清理) | 'direct'(直接 commit+push 到 base 分支)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS delivery_mode text NOT NULL DEFAULT 'pr'
  CHECK (delivery_mode IN ('pr', 'direct'));

-- merge_checked_at: periodic 轮询 PR 合并状态的轮转游标,NULL 优先检查
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS merge_checked_at timestamptz;

-- tasks.status 增加 'merged'(PR 已合并并清理 / 直推已落地)。001 内联 CHECK 被自动命名为
-- tasks_status_check,002 已重建过一次,这里再次先删后建。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'claimed', 'running', 'waiting', 'success', 'merged', 'failed', 'cancelled'));

-- 清理候选轮转索引:本 worker 的、已建 PR 的 success 任务,按 merge_checked_at 取最久未查的
CREATE INDEX IF NOT EXISTS tasks_cleanup_idx
  ON tasks(claimed_by, merge_checked_at)
  WHERE status = 'success' AND pr_url IS NOT NULL;
