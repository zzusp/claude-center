"use client";

import type { Task, TaskComment } from "@claude-center/db";
import { Bot, MessageSquare, Send, UserRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { Empty, fmtTime } from "./shared";
import { usePolling } from "../lib/use-polling";
import { useAsyncAction } from "../lib/use-async-action";

// 任务对话 Tab：comments 按 tab 懒轮询（仅本 tab 打开时拉）+ waiting 态回复续接。
export function TaskConversation({
  task,
  canComment
}: {
  task: Task;
  canComment: boolean;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [reply, setReply] = useState("");
  const { busy, error, run } = useAsyncAction();
  const waiting = task.status === "waiting";
  const canReply = waiting && canComment;

  usePolling(
    async (isActive) => {
      try {
        const response = await fetch(`/api/tasks/${task.id}/comments`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { comments: TaskComment[] };
        if (isActive()) setComments(data.comments);
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [task.id]
  );

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reply.trim()) return;
    await run(async () => {
      const response = await fetch(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: reply.trim() })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `回复失败：${response.status}`);
      }
      const data = (await response.json()) as { comment: TaskComment };
      setComments((prev) => [...prev, data.comment]);
      setReply("");
    });
  }

  return (
    <div className="chat">
      {comments.length === 0 ? (
        <Empty
          icon={<MessageSquare size={28} />}
          text="暂无对话。Worker 需要确认时会在此提问。"
        />
      ) : (
        <div className="chat-stream">
          {comments.map((comment) => (
            <div className={`chat-msg ${comment.author}`} key={comment.id}>
              <span className="chat-avatar" data-author={comment.author}>
                {comment.author === "worker" ? <Bot size={14} /> : <UserRound size={14} />}
              </span>
              <div className="chat-bubble">
                <div className="chat-meta">
                  <span className="chat-author">{comment.author === "worker" ? "Worker / Claude" : "你"}</span>
                  <span className="chat-time">{fmtTime(comment.created_at)}</span>
                </div>
                <div className="chat-body">{comment.body}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <form className="chat-input" onSubmit={submitReply}>
        <textarea
          rows={3}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder={
            !canComment
              ? "你没有任务对话权限"
              : waiting
                ? "回复 Worker 的提问，提交后将续接执行…"
                : "仅在任务「等待回复」时可回复"
          }
          disabled={!canReply || busy}
        />
        {error ? <div className="error-box">{error}</div> : null}
        <div className="chat-actions">
          <button className="btn btn-primary" type="submit" disabled={!canReply || busy || !reply.trim()}>
            <Send size={16} />
            {!canComment ? "无回复权限" : waiting ? "回复并续接" : "等待 Worker 提问"}
          </button>
        </div>
      </form>
    </div>
  );
}
