"use client";

import type { Task, TaskComment, TaskEvent, TaskPredecessor } from "@claude-center/db";
import {
  Bot,
  Check,
  ChevronLeft,
  ExternalLink,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Send,
  UserRound
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { Empty, KvRow, StatusBadge, TaskTypeBadge, fmtTime, metaOf, postJson } from "./shared";
import { usePolling } from "../lib/use-polling";

type DetailTab = "overview" | "timeline" | "logs" | "conversation";

const EVENT_LABEL: Record<string, string> = {
  running: "开始执行",
  success: "执行完成",
  merged: "已合并",
  failed: "执行失败",
  waiting: "等待回复",
  scheduled_published: "定时到点·进入待处理"
};

export default function TaskDetailPage({
  initialTask,
  initialPredecessors,
  canCreateTask,
  canComment
}: {
  initialTask: Task;
  initialPredecessors: TaskPredecessor[];
  canCreateTask: boolean;
  canComment: boolean;
}) {
  const router = useRouter();
  const taskId = initialTask.id;
  const [task, setTask] = useState<Task>(initialTask);
  const [predecessors, setPredecessors] = useState<TaskPredecessor[]>(initialPredecessors);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [detailTab, setDetailTab] = useState<DetailTab>(
    // 问答类默认进「对话」tab（对话即主要交互），工作类进「概览」。
    initialTask.task_type === "qa" ? "conversation" : "overview"
  );
  const [publishing, setPublishing] = useState(false);

  // 单任务详情轮询：状态翻转 / PR 链接 / 前置阻塞会随之刷新。
  async function loadTask() {
    try {
      const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { task: Task; predecessors: TaskPredecessor[] };
      setTask(data.task);
      setPredecessors(data.predecessors);
    } catch {
      /* 轮询失败静默，下次重试 */
    }
  }

  usePolling(
    async (isActive) => {
      try {
        const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { task: Task; predecessors: TaskPredecessor[] };
        if (isActive()) {
          setTask(data.task);
          setPredecessors(data.predecessors);
        }
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [taskId]
  );

  // 真实 task_events，喂给时间线。
  usePolling(
    async (isActive) => {
      try {
        const response = await fetch(`/api/tasks/${taskId}/events`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { events: TaskEvent[] };
        if (isActive()) setEvents(data.events);
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [taskId]
  );

  function handleBack() {
    // 多数情况由列表点击进入，回退即回到来源页；直接打开链接（无历史）时退回首页。
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push("/");
    }
  }

  async function publish() {
    setPublishing(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" })
      });
      if (response.ok) {
        await loadTask();
      }
    } finally {
      setPublishing(false);
    }
  }

  const isQa = task.task_type === "qa";
  const isBlocked = task.status === "pending" && (task.blocked ?? false);

  const lifecycle: { label: string; time: string | null; state: "done" | "active" | "idle" }[] = [
    { label: "已创建", time: task.created_at, state: "done" },
    { label: "已认领", time: task.claimed_at, state: task.claimed_at ? "done" : "idle" },
    {
      label: "开始执行",
      time: task.started_at,
      state: task.started_at ? (task.status === "running" ? "active" : "done") : "idle"
    },
    {
      label:
        task.status === "failed"
          ? "执行失败"
          : task.status === "cancelled"
            ? "已取消"
            : task.status === "merged"
              ? "已合并落地"
              : "执行完成",
      time: task.finished_at,
      state: task.finished_at ? "done" : "idle"
    },
    {
      label: task.status === "accepted" ? "已验收" : task.status === "rejected" ? "已打回" : "人工验收",
      time: null,
      state: task.status === "accepted" ? "done" : task.status === "success" ? "active" : "idle"
    }
  ];

  const depIds = task.depends_on ?? [];
  const preById = useMemo(() => new Map(predecessors.map((pre) => [pre.id, pre])), [predecessors]);

  const logText =
    [
      task.error_message ? `[error] ${task.error_message}` : "",
      task.result && Object.keys(task.result).length > 0 ? JSON.stringify(task.result, null, 2) : ""
    ]
      .filter(Boolean)
      .join("\n\n") || "暂无日志输出";

  return (
    <div className="detail-page">
      <header className="detail-page-top">
        <button type="button" className="detail-back" onClick={handleBack}>
          <ChevronLeft size={16} />
          返回任务流
        </button>
        <div className="detail-page-head">
          <h1 className="detail-page-title">{task.title}</h1>
          <div className="detail-tags">
            <StatusBadge status={task.status} />
            {isBlocked ? (
              <span className="badge" data-tone="pending">
                ⛔ 前置未完成·阻塞中
              </span>
            ) : null}
            <TaskTypeBadge type={task.task_type} />
            {isQa ? null : (
              <>
                <span className="tag">
                  <GitBranch size={13} className="ico" />
                  {task.base_branch} → {task.work_branch}
                </span>
                <span className="tag">
                  {task.submit_mode === "push" ? `直推 ${task.target_branch}` : `PR → ${task.target_branch}`}
                </span>
              </>
            )}
            {!isQa && task.pr_url ? (
              <a className="tag" href={task.pr_url} target="_blank" rel="noreferrer">
                <ExternalLink size={13} className="ico" />
                PR
              </a>
            ) : null}
            {(task.status === "draft" || task.status === "scheduled") && canCreateTask ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={publishing}
                onClick={() => void publish()}
              >
                <Send size={14} />
                {task.status === "scheduled" ? "立即发布" : "发布"}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="detail-page-body">
        <section className="card detail-card">
          <div className="tabs">
            {(["overview", "conversation", "timeline", "logs"] as DetailTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                className={`tab${detailTab === tab ? " active" : ""}`}
                onClick={() => setDetailTab(tab)}
              >
                {tab === "overview"
                  ? "概览"
                  : tab === "conversation"
                    ? "对话"
                    : tab === "timeline"
                      ? "时间线"
                      : "日志"}
              </button>
            ))}
          </div>

          <div className="tab-body">
            {detailTab === "overview" ? (
              <div className="kv">
                {task.status === "success" && canCreateTask ? (
                  <TaskReviewActions task={task} onReviewed={loadTask} />
                ) : null}
                <KvRow k="项目" v={task.project_name ?? task.project_id} />
                <KvRow k="类型" v={isQa ? "问答类 · 纯对话" : "工作类 · 改代码开 PR"} />
                <KvRow k={isQa ? "问题" : "描述"} v={task.description} />
                {isQa ? null : (
                  <>
                    <KvRow k="签出分支" v={task.base_branch} mono />
                    <KvRow k="工作分支" v={task.work_branch} mono />
                    <KvRow k="目标分支" v={task.target_branch} mono />
                    <KvRow k="提交模式" v={task.submit_mode === "push" ? "直接提交推送" : "创建 PR"} />
                  </>
                )}
                <KvRow
                  k="执行模型"
                  v={{ default: "默认（跟随 Worker）", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" }[task.model]}
                />
                <KvRow k="Session ID" v={task.claude_session_id ?? "—"} mono />
                {depIds.length > 0 ? (
                  <KvRow
                    k="前置任务"
                    v={
                      <div className="pill-row">
                        {depIds.map((id, index) => {
                          const pre = preById.get(id);
                          return pre ? (
                            <span className="pill" key={pre.id}>
                              [{metaOf(pre.status).label}] {pre.title}
                            </span>
                          ) : (
                            <span className="pill" key={index}>
                              已删除任务
                            </span>
                          );
                        })}
                      </div>
                    }
                  />
                ) : null}
                {!isQa && task.pr_url ? (
                  <KvRow
                    k="PR"
                    v={
                      <a href={task.pr_url} target="_blank" rel="noreferrer">
                        {task.pr_url}
                      </a>
                    }
                  />
                ) : null}
                {task.scheduled_at ? (
                  <KvRow
                    k="定时发布"
                    v={
                      task.status === "scheduled"
                        ? `${fmtTime(task.scheduled_at)}（到点自动进入待处理）`
                        : fmtTime(task.scheduled_at)
                    }
                  />
                ) : null}
                <KvRow k="创建于" v={fmtTime(task.created_at)} />
                <KvRow k="更新于" v={fmtTime(task.updated_at)} />
                {task.error_message ? <div className="error-box">{task.error_message}</div> : null}
              </div>
            ) : null}

            {detailTab === "timeline" ? (
              <div className="timeline">
                {lifecycle.map((item, index) => (
                  <div className="tl-item" key={`lc-${index}`}>
                    <span
                      className={`tl-node${item.state === "done" ? " done" : item.state === "active" ? " active" : ""}`}
                    />
                    <div>
                      <div className="tl-label">{item.label}</div>
                      <div className="tl-time">{item.time ? fmtTime(item.time) : "—"}</div>
                    </div>
                  </div>
                ))}
                {events.length > 0 ? (
                  <>
                    <div className="tl-sep">执行事件</div>
                    {events.map((event) => (
                      <div className="tl-item" key={event.id}>
                        <span className="tl-node done" />
                        <div>
                          <div className="tl-label">
                            {EVENT_LABEL[event.event_type] ?? event.event_type}
                            {event.message ? <span className="tl-msg"> · {event.message}</span> : null}
                          </div>
                          <div className="tl-time">{fmtTime(event.created_at)}</div>
                        </div>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}

            {detailTab === "conversation" ? (
              <TaskConversation task={task} canComment={canComment} canCreateTask={canCreateTask} />
            ) : null}

            {detailTab === "logs" ? <pre className="logs">{logText}</pre> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function TaskReviewActions({ task, onReviewed }: { task: Task; onReviewed: () => void | Promise<void> }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review(action: "accept" | "reject") {
    if (action === "reject" && !feedback.trim()) {
      setError("打回必须填写意见");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/tasks/${task.id}/review`, {
        action,
        feedback: action === "reject" ? feedback.trim() : undefined
      });
      setRejecting(false);
      setFeedback("");
      await onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-actions">
      <div className="review-hint">该任务已执行完成，待人工验收。</div>
      {rejecting ? (
        <>
          <textarea
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="填写打回意见，Worker 将带着该意见续接重跑…"
            disabled={busy}
          />
          <div className="review-btns">
            <button className="btn btn-sm" type="button" onClick={() => setRejecting(false)} disabled={busy}>
              取消
            </button>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => review("reject")}
              disabled={busy || !feedback.trim()}
            >
              <RotateCcw size={15} />
              确认打回
            </button>
          </div>
        </>
      ) : (
        <div className="review-btns">
          <button className="btn btn-primary btn-sm" type="button" onClick={() => review("accept")} disabled={busy}>
            <Check size={15} />
            验收通过
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setRejecting(true)} disabled={busy}>
            <RotateCcw size={15} />
            打回重跑
          </button>
        </div>
      )}
      {error ? <div className="error-box">{error}</div> : null}
    </div>
  );
}

function TaskConversation({
  task,
  canComment,
  canCreateTask
}: {
  task: Task;
  canComment: boolean;
  canCreateTask: boolean;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = task.status === "waiting";
  const isQa = task.task_type === "qa";
  const closed = ["success", "failed", "cancelled"].includes(task.status);
  const canReply = waiting && canComment;

  async function closeConversation() {
    setClosing(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete" })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `结束失败：${response.status}`);
      }
      // 状态翻转交给详情轮询刷新；这里不本地改 task。
    } catch (err) {
      setError(err instanceof Error ? err.message : "结束失败");
    } finally {
      setClosing(false);
    }
  }

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
    setBusy(true);
    setError(null);
    try {
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "回复失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      {comments.length === 0 ? (
        <Empty
          icon={<MessageSquare size={28} />}
          text={isQa ? "等待 Claude 回答…答案会显示在这里。" : "暂无对话。Worker 需要确认时会在此提问。"}
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
                ? isQa
                  ? "继续追问，提交后 Claude 会续接同一会话回答…"
                  : "回复 Worker 的提问，提交后将续接执行…"
                : isQa
                  ? closed
                    ? "对话已结束"
                    : "等待 Claude 回答中…"
                  : "仅在任务「等待回复」时可回复"
          }
          disabled={!canReply || busy}
        />
        {error ? <div className="error-box">{error}</div> : null}
        <div className="chat-actions">
          <button className="btn btn-primary" type="submit" disabled={!canReply || busy || !reply.trim()}>
            <Send size={16} />
            {!canComment ? "无回复权限" : waiting ? (isQa ? "发送追问" : "回复并续接") : isQa ? "等待回答" : "等待 Worker 提问"}
          </button>
          {isQa && !closed && canCreateTask ? (
            <button type="button" className="btn btn-sm" onClick={closeConversation} disabled={closing}>
              结束对话
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
