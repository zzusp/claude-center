"use client";

import type { Task, TaskEvent, TaskPredecessor, TaskRepo } from "@claude-center/db";
import { ChevronLeft, ExternalLink, Pencil, RefreshCw, RotateCcw, Send, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { StatusBadge, fmtTime } from "./shared";
import { Drawer, useConfirm } from "./controls";
import { usePolling } from "../lib/use-polling";
import { DETAIL_TABS, type DetailTabKey } from "./task-detail-shared";
import { OverviewTab } from "./task-detail-overview";
import { TimelineTab } from "./task-detail-timeline";
import { TaskConversation } from "./task-detail-conversation";
import { SessionTranscript } from "./task-detail-session";
import { TaskEditForm } from "./task-detail-edit-form";

// 任务流列表的编辑抽屉复用同一表单，从这里再导出（保留历史导入路径 ./task-detail）。
export { TaskEditForm };

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
  // 多仓任务（spec docs/spec/task-multi-repo.md）：每个仓的执行快照（sub_status / pr_url / 错误），
  // 单仓任务退化为 1 行 main，行为对老 UI 无差别。
  const [taskRepos, setTaskRepos] = useState<TaskRepo[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Tab 化后顶栏 actions：编辑走 Drawer、删除走 useConfirm，与列表页一致。
  const [activeTab, setActiveTab] = useState<DetailTabKey>("overview");
  const { confirm, dialog } = useConfirm();

  // 单任务详情轮询：task（状态翻转 / PR 链接 / 前置阻塞）+ predecessors + task_events 一次取齐
  //（/api/tasks/[id] 已聚合 events，省一次常驻往返）。comments / session 仍由各自 tab 子组件懒轮询。
  async function loadTask() {
    try {
      const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { task: Task; predecessors: TaskPredecessor[]; events: TaskEvent[]; taskRepos?: TaskRepo[] };
      setTask(data.task);
      setPredecessors(data.predecessors);
      setEvents(data.events);
      setTaskRepos(data.taskRepos ?? []);
    } catch {
      /* 轮询失败静默，下次重试 */
    }
  }

  usePolling(
    async (isActive) => {
      try {
        const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { task: Task; predecessors: TaskPredecessor[]; events: TaskEvent[]; taskRepos?: TaskRepo[] };
        if (isActive()) {
          setTask(data.task);
          setPredecessors(data.predecessors);
          setEvents(data.events);
          setTaskRepos(data.taskRepos ?? []);
        }
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

  // 激活回草稿：清空运行态、退回 draft，由用户重新发布——推倒重来。
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

  // 续接重试：保留工作树 + Claude 会话，带着失败原因/中断点接着干（不回草稿）。Worker 下一轮认领续接。
  async function retry() {
    setRetrying(true);
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry" })
      });
      if (response.ok) {
        await loadTask();
      }
    } finally {
      setRetrying(false);
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
  // 失败/已取消可续接重试（保留工作树/会话，接着干）或激活回草稿（清空重写）。
  const canRetry = (task.status === "failed" || task.status === "cancelled") && canCreateTask;
  const canReactivate = canRetry;

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
            {canRetry ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={retrying} onClick={() => void retry()}>
                <RotateCcw size={14} />
                {retrying ? "重试中…" : "续接重试"}
              </button>
            ) : null}
            {canReactivate ? (
              <button type="button" className="btn btn-sm" disabled={reactivating} onClick={() => void reactivate()}>
                <RefreshCw size={14} />
                {reactivating ? "激活中…" : "激活回草稿"}
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
            taskRepos={taskRepos}
            lifecycle={lifecycle}
            modelLabel={modelLabel}
            depIds={depIds}
            preById={preById}
            canReview={canReview}
            onReviewed={loadTask}
          />
        ) : null}

        {activeTab === "timeline" ? (
          <TimelineTab
            events={events}
            lifecycle={lifecycle}
            task={task}
            canRetry={canRetry}
            onRetry={retry}
            onJumpToExecution={() => setActiveTab("execution")}
          />
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
