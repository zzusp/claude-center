-- 任务级累计 token 用量：Worker 每轮 `claude --output-format json` 执行后，把该轮 usage 的
-- input/output/cache_creation/cache_read 四类 token 求和，累加到此列（首轮/续接/重试逐轮叠加）。
-- 作任务列表展示 + 升降序排序的权威来源。additive、默认 0，对现有任务零破坏。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS total_tokens bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN tasks.total_tokens IS '任务开发累计 token 用量：Worker 每轮 claude --output-format json 的 usage（input+output+cache_creation+cache_read）求和后逐轮累加；用于任务列表展示与排序。默认 0。';
