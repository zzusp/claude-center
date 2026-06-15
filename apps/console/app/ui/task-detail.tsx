"use client";

import type { Task, TaskComment, TaskEvent, TaskPredecessor } from "@claude-center/db";
import {
  Activity,
  Bot,
  Check,
  ChevronLeft,
  ExternalLink,
  FileText,
  Info,
  ListChecks,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Send,
  Terminal,
  Trash2,
  UserRound,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, useMemo, useRef, useState } from "react";
import { Empty, KvRow, StatusBadge, fmtTime, postJson } from "./shared";
import { Drawer, useConfirm } from "./controls";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";

type DetailTabKey = "overview" | "timeline" | "chat" | "execution" | "logs";

const DETAIL_TABS: { key: DetailTabKey; label: string; icon: ReactNode }[] = [
  { key: "overview", label: "概览", icon: <FileText size={14} /> },
  { key: "timeline", label: "时间线", icon: <Activity size={14} /> },
  { key: "chat", label: "对话", icon: <MessageSquare size={14} /> },
  { key: "execution", label: "Claude Code 执行", icon: <Terminal size={14} /> },
  { key: "logs", label: "日志", icon: <ScrollText size={14} /> }
];

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
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  // Tab 化后顶栏 actions：编辑走 Drawer、删除走 useConfirm，与列表页一致。
  const [activeTab, setActiveTab] = useState<DetailTabKey>("overview");
  const { confirm, dialog } = useConfirm();

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

  // 真实 task_events，喂给「活动」区。
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

  // 取消在途任务：对 claimed/running/waiting 打取消请求戳，Worker 扫到后杀 Claude 进程并翻 cancelled。
  async function cancel() {
    setCancelling(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" })
      });
      if (response.ok) {
        await loadTask();
      }
    } finally {
      setCancelling(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "删除任务",
      message: `确认删除任务「${task.title}」？此操作不可撤销。`,
      confirmText: "删除任务",
      danger: true
    });
    if (!ok) return;
    const response = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (response.ok) {
      handleBack();
    }
  }

  async function reactivate() {
    setReactivating(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reactivate" })
      });
      if (response.ok) {
        await loadTask();
      }
    } finally {
      setReactivating(false);
    }
  }

  const isBlocked = task.status === "pending" && (task.blocked ?? false);
  const canPublish = (task.status === "draft" || task.status === "scheduled") && canCreateTask;
  const canReview = task.status === "success" && canCreateTask;
  // 在途态可取消（已认领 / 执行中 / 等待回复）。
  const isCancellable = task.status === "claimed" || task.status === "running" || task.status === "waiting";
  // 仅草稿/定时态可编辑（执行前）。
  const canEdit = (task.status === "draft" || task.status === "scheduled") && canCreateTask;
  // 仅「已认领 / 执行中」在途态禁止删除，其余状态均可删除。
  const canDelete = task.status !== "claimed" && task.status !== "running" && canCreateTask;
  // 失败/已取消可重新激活（退回草稿后重新发布）。
  const canReactivate = (task.status === "failed" || task.status === "cancelled") && canCreateTask;

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

  const modelLabel = { default: "默认（跟随 Worker）", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" }[task.model];

  return (
    <div className="detail-page">
      <header className="detail-page-top">
        <button type="button" className="detail-back" onClick={handleBack}>
          <ChevronLeft size={16} />
          返回任务流
        </button>
        <div className="detail-page-head">
          <div className="detail-head-title">
            <h1 className="detail-page-title">{task.title}</h1>
            <StatusBadge status={task.status} />
            {isBlocked ? (
              <span className="badge" data-tone="pending">⛔ 前置未完成·阻塞中</span>
            ) : null}
          </div>
          <div className="detail-actions">
            {canPublish ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={publishing} onClick={() => void publish()}>
                <Send size={14} />
                {task.status === "scheduled" ? "立即发布" : "发布"}
              </button>
            ) : null}
            {canEdit ? (
              <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                <Pencil size={14} />
                编辑
              </button>
            ) : null}
            {canReactivate ? (
              <button type="button" className="btn btn-sm" disabled={reactivating} onClick={() => void reactivate()}>
                <RefreshCw size={14} />
                {reactivating ? "重试中…" : "重试"}
              </button>
            ) : null}
            {isCancellable && canCreateTask ? (
              <button type="button" className="btn btn-sm" disabled={cancelling} onClick={() => void cancel()}>
                <X size={14} />
                {cancelling ? "取消中…" : "取消任务"}
              </button>
            ) : null}
            {canDelete ? (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void handleDelete()}>
                <Trash2 size={14} />
                删除
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="detail-summary-bar">
        <div className="ds-item">
          <span className="ds-k">Task ID</span>
          <span className="ds-v mono">{task.id}</span>
        </div>
        <div className="ds-item">
          <span className="ds-k">项目</span>
          <span className="ds-v">{task.project_name ?? task.project_id}</span>
        </div>
        <div className="ds-item">
          <span className="ds-k">分支</span>
          <span className="ds-v mono">{task.base_branch} → {task.work_branch}</span>
        </div>
        <div className="ds-item">
          <span className="ds-k">Worker</span>
          <span className="ds-v">{task.worker_name ?? "—"}</span>
        </div>
        <div className="ds-item">
          <span className="ds-k">创建时间</span>
          <span className="ds-v">{fmtTime(task.created_at)}</span>
        </div>
        {task.pr_url ? (
          <div className="ds-item">
            <span className="ds-k">PR</span>
            <a className="ds-v" href={task.pr_url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} className="ico" />
              {task.pr_url}
            </a>
          </div>
        ) : null}
      </div>

      <nav className="detail-tabs">
        {DETAIL_TABS.map((tab) => (
          <button
            type="button"
            key={tab.key}
            className={`detail-tab-btn${activeTab === tab.key ? " is-active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className="dt-ico">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="detail-tab-content">
        {activeTab === "overview" ? (
          <OverviewTab
            task={task}
            lifecycle={lifecycle}
            modelLabel={modelLabel}
            depIds={depIds}
            preById={preById}
            canReview={canReview}
            onReviewed={loadTask}
          />
        ) : null}

        {activeTab === "timeline" ? (
          <TimelineTab events={events} lifecycle={lifecycle} />
        ) : null}

        {activeTab === "chat" ? (
          <section className="card detail-section">
            <div className="section-body">
              <TaskConversation task={task} canComment={canComment} />
            </div>
          </section>
        ) : null}

        {activeTab === "execution" ? (
          <section className="card detail-section">
            <div className="section-body">
              <SessionTranscript task={task} />
            </div>
          </section>
        ) : null}

        {activeTab === "logs" ? (
          <section className="card detail-section">
            <div className="section-body">
              <pre className="logs">{logText}</pre>
            </div>
          </section>
        ) : null}
      </div>

      <Drawer
        open={editing}
        title={`编辑 ${task.title}`}
        onClose={() => setEditing(false)}
      >
        {editing ? (
          <TaskEditForm
            key={task.id}
            task={task}
            onSaved={(updated) => {
              setTask(updated);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </Drawer>

      {dialog}
    </div>
  );
}

// 概览 Tab：高亮验收行（success 态） + 描述/错误 + 信息 + 前置任务。
function OverviewTab({
  task,
  lifecycle,
  modelLabel,
  depIds,
  preById,
  canReview,
  onReviewed
}: {
  task: Task;
  lifecycle: { label: string; time: string | null; state: "done" | "active" | "idle" }[];
  modelLabel: string;
  depIds: string[];
  preById: Map<string, TaskPredecessor>;
  canReview: boolean;
  onReviewed: () => void | Promise<void>;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-main">
        {canReview ? (
          <section className="card detail-section">
            <div className="section-body">
              <TaskReviewActions task={task} onReviewed={onReviewed} />
            </div>
          </section>
        ) : null}

        <Section icon={<FileText size={15} />} title="任务描述">
          <p className="detail-desc">{task.description || "（无描述）"}</p>
          {task.error_message ? <div className="error-box">{task.error_message}</div> : null}
        </Section>

        <Section icon={<Activity size={15} />} title="执行进度">
          <div className="lifecycle-bar">
            {lifecycle.map((item, index) => (
              <div className={`lc-step ${item.state}`} key={`lc-${index}`}>
                <span className="lc-node" />
                <div className="lc-text">
                  <div className="lc-label">{item.label}</div>
                  <div className="lc-time">{item.time ? fmtTime(item.time) : "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <aside className="detail-side">
        <Section icon={<Info size={15} />} title="信息">
          <div className="kv">
            <KvRow k="项目" v={task.project_name ?? task.project_id} />
            <KvRow k="签出分支" v={task.base_branch} mono />
            <KvRow k="工作分支" v={task.work_branch} mono />
            <KvRow k="目标分支" v={task.target_branch} mono />
            <KvRow k="提交模式" v={task.submit_mode === "push" ? "直接提交推送" : "创建 PR"} />
            {task.submit_mode === "pr" ? (
              <KvRow k="自动合并 PR" v={task.auto_merge_pr ? "是 · 创建后自动合并" : "否"} />
            ) : null}
            <KvRow k="自动回复" v={task.auto_reply ? "是 · 无人值守兜底（cap=2）" : "否"} />
            {task.auto_reply && task.auto_decision_hints ? (
              <KvRow k="决策预案" v={task.auto_decision_hints} />
            ) : null}
            <KvRow k="执行模型" v={modelLabel} />
            <KvRow k="Worker" v={task.worker_name ?? "—"} />
            <KvRow k="Session ID" v={task.claude_session_id ?? "—"} mono />
            {task.pr_url ? (
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
          </div>
        </Section>

        {depIds.length > 0 ? (
          <Section icon={<ListChecks size={15} />} title="前置任务">
            <div className="dep-list">
              {depIds.map((id, index) => {
                const pre = preById.get(id);
                return pre ? (
                  <a className="dep-item" href={`/tasks/${pre.id}`} key={pre.id}>
                    <StatusBadge status={pre.status} />
                    <span className="dep-title">{pre.title}</span>
                  </a>
                ) : (
                  <span className="dep-item is-gone" key={index}>
                    <span className="badge" data-tone="cancelled">已删除任务</span>
                  </span>
                );
              })}
            </div>
          </Section>
        ) : null}
      </aside>
    </div>
  );
}

// 时间线 Tab：lifecycle 阶段头 + task_events 时间轴。
function TimelineTab({
  events,
  lifecycle
}: {
  events: TaskEvent[];
  lifecycle: { label: string; time: string | null; state: "done" | "active" | "idle" }[];
}) {
  return (
    <div className="detail-tab-stack">
      <Section icon={<Activity size={15} />} title="执行阶段">
        <div className="lifecycle-bar">
          {lifecycle.map((item, index) => (
            <div className={`lc-step ${item.state}`} key={`tl-lc-${index}`}>
              <span className="lc-node" />
              <div className="lc-text">
                <div className="lc-label">{item.label}</div>
                <div className="lc-time">{item.time ? fmtTime(item.time) : "—"}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={<Activity size={15} />} title="事件流">
        {events.length > 0 ? (
          <div className="timeline">
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
          </div>
        ) : (
          <Empty icon={<Activity size={24} />} text="暂无执行事件" />
        )}
      </Section>
    </div>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card detail-section">
      <div className="section-head">
        <span className="section-ico">{icon}</span>
        <h3 className="section-title">{title}</h3>
      </div>
      <div className="section-body">{children}</div>
    </section>
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

export function TaskEditForm({
  task,
  onSaved,
  onCancel
}: {
  task: Task;
  onSaved: (updated: Task) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitMode, setSubmitMode] = useState<"pr" | "push">(task.submit_mode);
  const [autoMergePr, setAutoMergePr] = useState(task.auto_merge_pr);
  const [autoReply, setAutoReply] = useState(task.auto_reply);
  const [autoDecisionHints, setAutoDecisionHints] = useState(task.auto_decision_hints);
  const [model, setModel] = useState(task.model);

  // datetime-local 值格式：去掉秒+时区（只保留 "YYYY-MM-DDTHH:MM"）
  const scheduledAtDefault = task.scheduled_at
    ? task.scheduled_at.slice(0, 16)
    : "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scheduledAtRaw = (data.get("scheduledAt") as string) || "";
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          title: data.get("title") as string,
          description: data.get("description") as string,
          baseBranch: data.get("baseBranch") as string,
          workBranch: data.get("workBranch") as string,
          targetBranch: data.get("targetBranch") as string,
          submitMode,
          autoMergePr,
          autoReply,
          autoDecisionHints,
          model,
          scheduledAt: scheduledAtRaw ? new Date(scheduledAtRaw).toISOString() : null
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败：${response.status}`);
      }
      const payload = (await response.json()) as { task: Task };
      onSaved(payload.task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} style={{ width: "100%" }}>
      <div className="field">
        <label className="field-label">标题</label>
        <input name="title" defaultValue={task.title} required disabled={busy} />
      </div>
      <div className="field">
        <label className="field-label">目标</label>
        <textarea name="description" rows={4} defaultValue={task.description} required disabled={busy} />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">签出分支</label>
          <input name="baseBranch" defaultValue={task.base_branch} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label">PR 目标分支</label>
          <input name="targetBranch" defaultValue={task.target_branch} disabled={busy} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">工作分支</label>
          <input name="workBranch" defaultValue={task.work_branch} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label">提交模式</label>
          <select value={submitMode} onChange={(e) => setSubmitMode(e.target.value as "pr" | "push")} disabled={busy}>
            <option value="pr">创建 PR</option>
            <option value="push">直接提交推送</option>
          </select>
        </div>
      </div>
      {submitMode === "pr" ? (
        <div className="field">
          <label className="field-label">自动合并 PR</label>
          <select value={autoMergePr ? "on" : "off"} onChange={(e) => setAutoMergePr(e.target.value === "on")} disabled={busy}>
            <option value="off">否 · 仅创建 PR</option>
            <option value="on">是 · 创建后自动合并</option>
          </select>
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">自动回复（兜底）</label>
        <select value={autoReply ? "on" : "off"} onChange={(e) => setAutoReply(e.target.value === "on")} disabled={busy}>
          <option value="off">否 · 等人回复（默认）</option>
          <option value="on">是 · 无人值守，按规则兜底</option>
        </select>
      </div>
      {autoReply ? (
        <div className="field">
          <label className="field-label">决策预案 <span className="field-hint">可选；auto_reply=true 时拼入 prompt</span></label>
          <textarea
            rows={2}
            value={autoDecisionHints}
            onChange={(e) => setAutoDecisionHints(e.target.value)}
            placeholder="prefer minimal change; keep existing patterns; ..."
            disabled={busy}
          />
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">执行模型</label>
        <select value={model} onChange={(e) => setModel(e.target.value as typeof model)} disabled={busy}>
          <option value="default">默认 · 跟随 Worker</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label">
          定时发布 <span className="field-hint">留空则为草稿</span>
        </label>
        <input name="scheduledAt" type="datetime-local" defaultValue={scheduledAtDefault} disabled={busy} />
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="review-btns">
        <button className="btn btn-sm" type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          <Check size={14} />
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}

function TaskConversation({
  task,
  canComment
}: {
  task: Task;
  canComment: boolean;
}) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

// —— 执行会话（Claude Code session transcript）—— //

// 任务执行会话回放：执行期间（claimed/running/waiting）每 5s 轮询，终态后再取数次拿到 Worker 最终强制同步的
// 完整 transcript 即停拉（避免持续拖大 blob）。Worker 周期 + 终态把 session .jsonl 同步到 task_sessions。
// 解析 + 富展示走共用 transcript.tsx（与对话页同款）。
function SessionTranscript({ task }: { task: Task }) {
  const [jsonl, setJsonl] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const doneRef = useRef(false);
  const termCountRef = useRef(0);
  const live = task.status === "claimed" || task.status === "running" || task.status === "waiting";

  usePolling(
    async (isActive) => {
      // 终态且已取够最终版（覆盖 Worker 终态强制同步的小窗）后停拉，不再重复拉大 blob。
      if (doneRef.current) return;
      try {
        const response = await fetch(`/api/tasks/${task.id}/session`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { jsonl: string | null; syncedAt: string | null };
        if (!isActive()) return;
        setJsonl(data.jsonl);
        setSyncedAt(data.syncedAt);
        setLoaded(true);
        if (!live) {
          termCountRef.current += 1;
          if (termCountRef.current >= 3) doneRef.current = true;
        }
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [task.id, live],
    5000
  );

  const items = useMemo(() => (jsonl ? parseTranscript(jsonl) : []), [jsonl]);

  if (!loaded) {
    return <Empty icon={<ScrollText size={28} />} text="加载中…" />;
  }
  if (items.length === 0) {
    return <Empty icon={<ScrollText size={28} />} text="暂无执行会话记录（Worker 执行后会同步到此）" />;
  }
  return (
    <div className="tx-wrap">
      <TranscriptView items={items} />
      {syncedAt ? <div className="session-synced">最近同步：{fmtTime(syncedAt)}</div> : null}
    </div>
  );
}
