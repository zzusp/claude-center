-- 任务分类：工作类（work，建分支/commit/PR）vs 问答类（qa，纯对话/不碰 git）
-- 方案见 docs/spec/task-types.md

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_type text NOT NULL DEFAULT 'work';

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_task_type_check
  CHECK (task_type IN ('work', 'qa'));
