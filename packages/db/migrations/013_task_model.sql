-- 任务级 Claude 执行模型：创建任务时指定该任务 worktree 执行用哪个 model。
-- 'default' 表示不指定，Worker 执行时不传 --model，跟随 claude 自身默认；
-- opus/sonnet/haiku 经 Worker 映射为 `claude --model <alias>`。additive，对现有任务零破坏。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'default'
    CHECK (model IN ('default', 'opus', 'sonnet', 'haiku'));
