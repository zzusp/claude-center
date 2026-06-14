-- 任务执行会话记录（Claude Code session transcript）。Worker 执行期间周期性同步当前任务对应的
-- transcript(.jsonl 全文)，终态(成功/失败/超时/取消)再强制同步一次保证完整；Console 读取解析后渲染整段会话。
--
-- 用 1:1 侧表而非 tasks 列：tasks 被多处 SELECT tasks.* / SELECT *（列表/认领/分页/merge 候选）读取，
-- 大文本列会让所有这些读路径拖着整份 transcript。侧表隔离大字段、读路径不受影响（同 conversation_message_chunks 思路）。

CREATE TABLE IF NOT EXISTS task_sessions (
  task_id   uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  jsonl     text NOT NULL,                       -- Claude Code session .jsonl 全文（NDJSON）
  synced_at timestamptz NOT NULL DEFAULT now()   -- 最近一次同步时间
);
