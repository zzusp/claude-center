-- 035_notification_review_required.sql
-- 新增通知类型 task_review_required：PR 已建但 Test Plan 未全部通过时，自动合并被门禁拦下，
-- Worker 给项目可见用户发此通知，交用户裁决（手动合并 / 续接任务）。
-- 见 docs/spec/pr-body-testplan-merge-gate.md。
--
-- 029 的 type 是行内 CHECK（约束名自动生成为 notifications_type_check）；这里 DROP 重建，
-- 列入当前全集（八种）——与「重建 CHECK 取全集」规约一致，避免废掉并行分支已加的类型。

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'task_claimed',
    'task_waiting',
    'task_success',
    'task_failed',
    'task_pr_created',
    'task_review_required',
    'worker_online',
    'worker_offline'
  ));

COMMENT ON COLUMN notifications.type IS '通知类型：task_claimed / task_waiting / task_success / task_failed / task_pr_created / task_review_required / worker_online / worker_offline。';
