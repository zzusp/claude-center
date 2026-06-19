-- 任务级「动态工作流」开关：控制 Claude Code 的 Workflows 特性是否对该任务启用。
-- Worker 执行时映射为 env：true→CLAUDE_CODE_WORKFLOWS=1（启用）；false→CLAUDE_CODE_DISABLE_WORKFLOWS=1（关闭）。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS dynamic_workflow boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tasks.dynamic_workflow IS '动态工作流开关：true 时 Worker 给 Claude 注入 CLAUDE_CODE_WORKFLOWS=1 启用 Claude Code Workflows（多代理编排）特性，false 注入 CLAUDE_CODE_DISABLE_WORKFLOWS=1 关闭；默认 false。';
