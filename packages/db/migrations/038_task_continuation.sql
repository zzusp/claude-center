-- 038_task_continuation.sql
-- 已完成任务（success / merged）的续跑机制。方案见 docs/spec/task-continuation.md
--
-- 用户对终态任务（success/merged）不满意时可发起「继续这个任务」：
--   - 复用原 Claude 会话（--resume claude_session_id）
--   - 区分两种终态：success → 复用原 work_branch 追加 commit；merged → 新分支 <work>-cont-N + 新 PR
--   - 续跑反馈以 user 评论入库 + worker 在续跑首帧拼到 prompt 给 Claude
--
-- 本迁移仅加 continuation_count 计数列与 continuation_requested_at 触发戳；不重建 tasks_status_check
--（合法状态值已有 success/merged，本期不引入 needs_continuation 之类中间态，复用 claimed/running/success/merged 状态机）。
-- continuation_requested_at 设计同 retry_requested_at：Console 打戳，Worker 扫到后认领续跑并清空，避免重复认领。

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS continuation_count int NOT NULL DEFAULT 0;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS continuation_requested_at timestamptz;

COMMENT ON COLUMN tasks.continuation_count IS '续跑轮次，每次从 success/merged 复活 +1，用于命名 worktree-<name>-cont-N 后缀和 PR body 引用';
COMMENT ON COLUMN tasks.continuation_requested_at IS 'Console 对 success/merged 任务发起「继续」时打的时间戳；Worker 扫到后认领续跑并清空，未请求为 NULL（同 retry_requested_at 的设计）';
