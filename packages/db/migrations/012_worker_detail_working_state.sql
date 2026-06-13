-- Worker 详情增强 + 工作状态门控 + 并行执行。全部 additive,对现有列零破坏。
-- claude_version：worker 机器上 `claude --version` 解析出的版本号。
-- subscription_type：max/pro/team/enterprise（套餐）/api（按量计费）/unknown。
-- usage：套餐用量快照 {five_hour:{utilization,resets_at}, seven_day:{utilization,resets_at}, fetched_at}。
-- working_state：在线 ≠ 接任务；idle 时 worker 不领新任务，需手动/远程切到 working。新 worker 默认 idle。
-- allow_remote_control：客户端策略，是否允许 web 端远程切换 working_state。
-- max_parallel：worker 同时执行任务的上限（真并发，工作树用 git worktree 隔离）。
ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS claude_version text,
  ADD COLUMN IF NOT EXISTS subscription_type text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS working_state text NOT NULL DEFAULT 'idle'
    CHECK (working_state IN ('idle', 'working')),
  ADD COLUMN IF NOT EXISTS allow_remote_control boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_parallel integer NOT NULL DEFAULT 1;
