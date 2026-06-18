-- 进程身份校验（防 pid 复用误连/误杀）：记录承接本轮 claude 进程的 OS 创建时间。
-- pid 退出后会被 OS 复用，仅看 pid 存活无法区分「还是原进程」还是「pid 被别的进程占了」（可能是用户另开的
-- claude session）；(pid, 创建时间) 才是稳定身份。worker 重启重连 / 取消杀进程前，要求当前 pid 的创建时间
-- 与此精确相等。承接 030，详见 docs/spec/conversation-turn-survive-restart.md §3。
ALTER TABLE conversation_messages
  ADD COLUMN IF NOT EXISTS claude_started_at bigint;

COMMENT ON COLUMN conversation_messages.claude_started_at IS 'claude 进程的 OS 创建时间（epoch ms）。配合 claude_pid 做 (pid,创建时间) 进程身份校验：重连/取消前要求当前 pid 的创建时间与此精确相等，否则视为「不是原进程」拒绝重连/不杀，杜绝 pid 复用导致误连/误杀其它 running 进程。';
COMMENT ON COLUMN conversation_messages.claude_pid IS '承接本轮的 claude 子进程 pid（detached 启动）。配合 claude_started_at（创建时间）做进程身份校验，区分重连 / 已退 / pid 被复用。仅 in-flight 轮有意义。';
