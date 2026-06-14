-- 014: 任务级「自动合并 PR」开关。开启后 Worker 在 PR 模式下创建 PR 后自动执行 gh pr merge。
ALTER TABLE tasks ADD COLUMN auto_merge_pr BOOLEAN NOT NULL DEFAULT false;
