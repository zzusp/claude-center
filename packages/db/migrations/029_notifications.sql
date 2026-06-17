-- 029_notifications.sql
-- 用户消息通知（Console 顶栏铃铛）：任务被领取 / 等待回复 / 完成 / 失败 / PR 已建 /
-- worker 上线 / worker 下线 等事件按访问范围分发给相关用户。
--
-- 设计要点：
-- 1) 每条通知按「单条独立行 + 一个收件人」存储，便于按 user_id 过滤未读 / 标记已读 / 删除。
--    一个事件可能写出 N 条通知（按可见性 fanout：admin + 项目分配用户）。
-- 2) link 是 Console 内的相对路径（如 /tasks/<id>），点击跳转用；可空。
-- 3) related_task_id / related_worker_id 用于去重、级联清理与跳转——任务/worker 被删则自动清掉。
-- 4) SSE 中断 / DB 中断属于前端实时感知的瞬时事件（DB 中断时本表也写不进），UI 侧合成展示，
--    不持久化。本表只承载需要审计、跨会话留存的事件。
-- 5) 不在此引入 GUC / 复杂索引，按 (user_id, read_at NULLS FIRST, created_at DESC) 单索引覆盖
--    「未读优先 + 时间序」查询。

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN (
    'task_claimed',
    'task_waiting',
    'task_success',
    'task_failed',
    'task_pr_created',
    'worker_online',
    'worker_offline'
  )),
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  related_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  related_worker_id uuid REFERENCES workers(id) ON DELETE CASCADE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications(user_id)
  WHERE read_at IS NULL;

COMMENT ON TABLE  notifications                   IS '用户消息通知：按收件人单条行存储；fanout 在写入侧完成（按 RBAC 范围派发）。';
COMMENT ON COLUMN notifications.id                IS '通知 ID。';
COMMENT ON COLUMN notifications.user_id           IS '收件人用户 ID（一通知一收件人）。';
COMMENT ON COLUMN notifications.type              IS '通知类型：task_claimed / task_waiting / task_success / task_failed / task_pr_created / worker_online / worker_offline。';
COMMENT ON COLUMN notifications.title             IS '一行标题（短，铃铛下拉直接展示）。';
COMMENT ON COLUMN notifications.body              IS '正文（可选，下拉里多行展示）。';
COMMENT ON COLUMN notifications.link              IS 'Console 内相对路径（如 /tasks/<id>），点击跳转用；空表示无跳转。';
COMMENT ON COLUMN notifications.related_task_id   IS '关联任务（task 删除时本通知 CASCADE 删）。';
COMMENT ON COLUMN notifications.related_worker_id IS '关联 worker（worker 删除时本通知 CASCADE 删）。';
COMMENT ON COLUMN notifications.read_at           IS '标记为已读的时间；NULL 表示未读。';
COMMENT ON COLUMN notifications.created_at        IS '生成时间。';
