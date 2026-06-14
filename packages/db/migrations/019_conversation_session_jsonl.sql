-- 对话执行会话记录（Claude Code session transcript）。与任务 task_sessions 同构：Worker 执行对话轮时
-- 周期 + 终态把该对话只读工作树对应的 session .jsonl 全文同步落库，Console 读取解析后做富展示（工具调用/
-- thinking/diff 等）。一个对话（多轮 --resume 续接）对应同一个 session 文件，故 1:1 侧表即可。
--
-- 对话改为统一 jsonl 轮询展示后，弃用流式分片那一套（SSE + pg_notify('cc_conversation') + 增量分片表）：
-- 删除 conversation_message_chunks。assistant 最终全文仍存在 conversation_messages.body（列表预览/降级用）。

CREATE TABLE IF NOT EXISTS conversation_sessions (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  jsonl           text NOT NULL,                       -- Claude Code session .jsonl 全文（NDJSON）
  synced_at       timestamptz NOT NULL DEFAULT now()   -- 最近一次同步时间
);

DROP TABLE IF EXISTS conversation_message_chunks;
