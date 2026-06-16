-- 终止实时对话回答：assistant 消息支持「请求取消 → 已取消」。
-- cancel_requested_at 标记 Console 端的取消时间；'cancelled' 状态由 Worker 杀进程后写入终态。
-- 写入约束保持 additive：仅扩展 conversation_messages 的 status 合法集，旧值不变。
ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

ALTER TABLE conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_status_check;

ALTER TABLE conversation_messages
  ADD CONSTRAINT conversation_messages_status_check
  CHECK (status IN ('pending', 'streaming', 'done', 'failed', 'cancelled'));
