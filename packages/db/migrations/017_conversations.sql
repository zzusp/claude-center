-- 实时直连对话（Worker Direct Chat）：独立于任务流的问答通道。
-- 指定项目(分支) + 指定 worker，多轮对话；助手回复经 conversation_message_chunks 流式落库（SSE 打字机）。
-- 与任务流彻底解耦：不进 tasks / 不走 claimNextTask / 不碰 git。方案见 docs/spec/worker-direct-chat.md

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- 对话针对的项目
  worker_id  uuid NOT NULL REFERENCES workers(id)  ON DELETE CASCADE,  -- 定向的具体 worker
  branch     text NOT NULL,                                            -- 只读检出的分支
  title      text NOT NULL DEFAULT '',
  model      text NOT NULL DEFAULT 'default'
             CHECK (model IN ('default', 'opus', 'sonnet', 'haiku')),  -- 复用 tasks.model 语义
  status     text NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'closed')),
  claude_session_id text,                                             -- 续接 --resume
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_worker_active_idx
  ON conversations(worker_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_project_idx
  ON conversations(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq  integer NOT NULL,                            -- 会话内单调递增，排序 + 派发判定
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  body text NOT NULL DEFAULT '',                    -- user: 提问全文；assistant: 收尾落最终全文
  status text NOT NULL DEFAULT 'done'
         CHECK (status IN ('pending', 'streaming', 'done', 'failed')),
  -- user 消息恒 'done'；assistant：claim 即 'streaming'，收尾 'done'/'failed'。
  claimed_by uuid REFERENCES workers(id) ON DELETE SET NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE INDEX IF NOT EXISTS conversation_messages_conv_idx
  ON conversation_messages(conversation_id, seq);

-- 流式分片，append-only：流式期间只写这里；turn 收尾把全文写回 conversation_messages.body。
-- SSE 断线重连靠 (message_id, seq) 从 Last-Event-ID 续传。
CREATE TABLE IF NOT EXISTS conversation_message_chunks (
  message_id uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  seq   integer NOT NULL,                           -- 该消息内分片序号，从 0 递增
  delta text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, seq)
);
