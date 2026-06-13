-- 任务执行中途确认：等待用户输入状态 + 会话续接 + 评论流
-- 方案见 docs/spec/task-comment-confirm.md

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claude_session_id text;

-- tasks.status 增加 'waiting'（等待用户回复后续接）。001 的内联 CHECK 被 Postgres
-- 自动命名为 tasks_status_check，先删后建。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'claimed', 'running', 'waiting', 'success', 'failed', 'cancelled'));

CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (author IN ('worker', 'user')),
  worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_comments_task_idx
  ON task_comments(task_id, created_at);
