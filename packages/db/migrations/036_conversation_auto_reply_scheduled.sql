-- 036: 实时对话（conversations）支持两项与任务表单同款的设置：
--   1) 自动回复（auto_reply + auto_decision_hints）——会话级开关，复用 tasks 的 021 语义：
--      开启后 Worker 执行对话轮时注入「无人值守」指令，让 Claude 自主决策、不停下来问；
--      auto_decision_hints 作为用户预先编码的决策偏好一并注入。
--   2) 定时发送消息（conversation_messages.scheduled_at + 'scheduled' 状态）——消息级定时：
--      到点由 Console 调度器（instrumentation-node）把 'scheduled' 翻 'done' 并赋 seq，进入可应答队列。
-- 两项在「新建对话」与「对话中」都可设置。方案见 docs/spec/conversation-auto-reply-scheduled.md

-- ── 会话级自动回复 ──────────────────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS auto_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_decision_hints text NOT NULL DEFAULT '';

COMMENT ON COLUMN conversations.auto_reply IS '自动回复（无人值守）：true 时 Worker 执行对话轮注入「自主决策、不停下来问」指令；复用 tasks.auto_reply 的设计。';
COMMENT ON COLUMN conversations.auto_decision_hints IS '决策预案：auto_reply=true 时拼进 prompt 作为用户预先编码的决策偏好。';

-- ── 消息级定时发送 ──────────────────────────────────────────────────────────
-- 定时消息在到点前不参与排序 / 派发 / prompt 聚合：故 seq 在「插入时」不分配（保持 NULL），
-- 由调度器在到点提升那一刻才赋 max(seq)+1。这样无论提前多久排定，触发时它都恰好是最新一条 user 消息，
-- 不会因插入时的旧 seq 落在后续 assistant 应答之前而被 claim / prompt 锚点漏掉。
-- UNIQUE(conversation_id, seq) 对多个 NULL 不冲突（PG NULL 互不相等），故多条待发定时消息可共存。
ALTER TABLE conversation_messages ALTER COLUMN seq DROP NOT NULL;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

-- status 增加 'scheduled'（定时待发）。沿用约定：重建 CHECK 时列出当前全部合法状态全集。
ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS conversation_messages_status_check;
ALTER TABLE conversation_messages ADD CONSTRAINT conversation_messages_status_check
  CHECK (status IN ('scheduled', 'pending', 'streaming', 'done', 'failed', 'cancelled'));

COMMENT ON COLUMN conversation_messages.seq IS '会话内单调递增序号，排序 + 派发 / prompt 锚点判定；定时消息（scheduled）在到点提升前为 NULL，提升时才赋 max(seq)+1。';
COMMENT ON COLUMN conversation_messages.scheduled_at IS '定时发送时间：status=''scheduled'' 的 user 消息到此刻由调度器翻 ''done'' 并赋 seq 进入可应答队列；非定时消息为 NULL。';
COMMENT ON COLUMN conversation_messages.status IS 'user 消息恒 done（定时消息先 scheduled、到点翻 done）；assistant：claim 即 streaming，收尾 done/failed，用户点终止则 cancelled。';

-- 调度器按 scheduled_at 捞到点消息：部分索引只覆盖待发的 scheduled 行。
CREATE INDEX IF NOT EXISTS conversation_messages_scheduled_idx
  ON conversation_messages(scheduled_at)
  WHERE status = 'scheduled';
