-- 对话轮「关机存活 + 重启重连」：记录承接该 assistant 轮的 claude 进程 pid 与 worktree cwd，
-- 供 worker 重启后判定该轮进程是否仍存活（重连）或已退出（从 .jsonl 收尾）。
-- 详见 docs/spec/conversation-turn-survive-restart.md。additive：仅给 conversation_messages 加两列。
ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS claude_pid bigint;

ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS claude_cwd text;

COMMENT ON COLUMN conversation_messages.claude_pid IS '承接本轮的 claude 子进程 pid（detached 启动）。worker 重启后据此 process.kill(pid,0) 判活：存活则重连、已退则从 .jsonl 收尾。仅 in-flight 轮有意义。';
COMMENT ON COLUMN conversation_messages.claude_cwd IS '本轮 claude 运行的 worktree 路径（会话只读检出）。worker 重启重连时据此定位 .jsonl transcript 文件。';
