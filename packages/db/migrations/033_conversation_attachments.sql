-- 033_conversation_attachments.sql
-- 实时对话（conversations）接入附件：兑现 024 留的扩展位（task-attachments.md §抉择3 / §边界）。
-- 给 attachments 表加第三种多态归属 conversation_message_id，绑定到某条 user 对话消息。
-- Worker 执行对话轮时把本轮 user 消息的附件落地到只读 worktree 的 .claude-attachments/，
-- 图片以本地路径写进 prompt 让 claude -p 读到（与 task / comment 同一套 Worker 流程）。

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS conversation_message_id uuid
    REFERENCES conversation_messages(id) ON DELETE CASCADE;

COMMENT ON COLUMN attachments.conversation_message_id IS
  '多态归属之三：绑定到某条 user 对话消息（conversation_messages.id）。删除消息/对话时经 FK 级联删除附件与 blob。与 task_id / task_comment_id 三选一（见表级 CHECK attachments_owner_one）。';

-- 重建归属唯一性 CHECK：024 建表时的匿名约束名为 attachments_check，三选一后扩成三列。
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_check;
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_owner_one;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_owner_one CHECK (
    (task_id IS NOT NULL)::int
    + (task_comment_id IS NOT NULL)::int
    + (conversation_message_id IS NOT NULL)::int
    <= 1
  );

-- 按 conversation_message_id 拉附件（Worker 本轮落地 + 详情展示）。
CREATE INDEX IF NOT EXISTS attachments_conv_msg_idx
  ON attachments(conversation_message_id, created_at)
  WHERE conversation_message_id IS NOT NULL;

-- 孤儿清理索引补一列：未绑定 = 三种归属皆 NULL。重建以纳入 conversation_message_id 条件。
DROP INDEX IF EXISTS attachments_orphan_idx;
CREATE INDEX IF NOT EXISTS attachments_orphan_idx
  ON attachments(owner_user_id, created_at)
  WHERE task_id IS NULL AND task_comment_id IS NULL AND conversation_message_id IS NULL;
