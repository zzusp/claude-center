-- 定时任务：新增 'scheduled'（定时待发）初始态 + scheduled_at 发布时间列
-- 方案见 docs/spec/task-scheduled.md
--
-- 建任务时指定发布时间 → 落 'scheduled' + scheduled_at；到点由 Console 后台调度器
-- 翻成 'pending' 进入可认领队列。与 'draft' 平行的另一个初始态，claimNextTask 不变
-- （仍只捞 'pending'），门禁自动生效。

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- 沿用本项目约定：每次重建约束都列出「当前全部合法状态全集」，避免覆盖回退此前
-- 各迁移引入的状态。本迁移在 007 的全集基础上再加 'scheduled'。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'draft', 'scheduled', 'pending', 'claimed', 'running', 'waiting', 'success',
    'merged', 'accepted', 'rejected', 'failed', 'cancelled'
  ));

-- 调度器按 scheduled_at 捞到点任务：部分索引只覆盖待发的 scheduled 行。
CREATE INDEX IF NOT EXISTS tasks_scheduled_idx
  ON tasks(scheduled_at)
  WHERE status = 'scheduled';
