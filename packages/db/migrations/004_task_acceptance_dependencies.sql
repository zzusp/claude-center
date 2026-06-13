-- 人工验收（accepted/rejected）+ 任务前置依赖门控
-- 方案见 docs/spec/task-acceptance-dependencies.md

-- tasks.status 增加 'accepted'（验收通过·终态）与 'rejected'（打回·待重跑）。
-- 沿用本项目约定：每次重建约束都列出「当前全部合法状态」。本迁移编号 004，排在并行分支
-- 的 003_task_cleanup（新增 'merged'）之后应用，故约束需带上 'merged' 以免覆盖回退该状态。
-- 约束名沿用 Postgres 自动命名 tasks_status_check，先删后建。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'pending', 'claimed', 'running', 'waiting', 'success',
    'merged', 'accepted', 'rejected', 'failed', 'cancelled'
  ));

-- 任务前置依赖：task 依赖 depends_on_task（多对多，仅同项目，约束在应用层校验）。
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_depends_idx
  ON task_dependencies(depends_on_task_id);
