-- 删除任务分类 task_type：问答类（qa）已从任务流移除，任务流只剩工作类。
-- 方案见 docs/acceptance/remove-qa-task-type/plan.md
-- task_type 唯一作用是区分 work/qa；qa 删除后该列恒为 'work'，属死字段，连同 CHECK 约束一并删。

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
ALTER TABLE tasks DROP COLUMN IF EXISTS task_type;
