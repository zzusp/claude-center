-- docs/spec/multi-round-task-history.md
--
-- 任务被续跑（continuation）或打回重跑（rerun）多轮时，原 tasks.result.claudeResult 每轮覆盖，
-- 历轮内容会丢失。本期改造让 markTaskSuccess() 在 JSONB 内追加 rounds[]，每轮 append 一条
-- {round, output, completedAt, prUrls, submitMode}，PR body / Console 执行结果 / 历史 PR 列表都从 rounds[] 读。
--
-- 本迁移仅更新 tasks.result 的列注释以文档化新结构；不改 schema、不回填历史任务（旧任务 rounds[] 缺失，
-- UI 走 claudeResult fallback）。

COMMENT ON COLUMN tasks.result IS '执行结果摘要（JSONB）：
- claudeResult: string                      最新一轮 Claude 输出（向后兼容旧 UI / 旧任务）。
- multiRepo: array<RepoResult>              最新一轮各仓收尾结果（pr/push/skipped/no_changes/failed）。
- workdir / submitMode / nonGit: 旧字段     首轮 finalize 时的工作目录与提交模式。
- rounds: array<RoundEntry>                 多轮累计：每轮 append 一条，markTaskSuccess() 写入。
  RoundEntry = { round: int, output: string, completedAt: ISO8601, prUrls: string[], submitMode: "pr"|"push"|"none" }
  其中 round == 任务当时的 continuation_count（0=首轮，1=第一次续跑）。';
