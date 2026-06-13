"use client";

import type { DirectCommand, Project, Task, TaskComment, Worker } from "@claude-center/db";
import {
  Activity,
  Boxes,
  Bot,
  Check,
  CircleAlert,
  Clock,
  Cpu,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Inbox,
  LayoutGrid,
  ListTodo,
  MessageSquare,
  Network,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  Tag,
  UserRound
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Overview = {
  projects: Project[];
  workers: Worker[];
  tasks: Task[];
  commands: DirectCommand[];
  summary: {
    onlineWorkers: number;
    pendingTasks: number;
    runningTasks: number;
    failedTasks: number;
  };
};

type ViewKey = "dashboard" | "tasks" | "workers" | "projects";
type DetailTab = "overview" | "timeline" | "logs" | "conversation";
type Tone = "success" | "running" | "pending" | "failed" | "cancelled" | "queued" | "waiting" | "review" | "rejected";

const emptyOverview: Overview = {
  projects: [],
  workers: [],
  tasks: [],
  commands: [],
  summary: { onlineWorkers: 0, pendingTasks: 0, runningTasks: 0, failedTasks: 0 }
};

const SPARK_CAP = 24;

const STATUS_META: Record<string, { glyph: string; label: string; tone: Tone }> = {
  pending: { glyph: "○", label: "待处理", tone: "pending" },
  claimed: { glyph: "◻", label: "已认领", tone: "queued" },
  running: { glyph: "◐", label: "执行中", tone: "running" },
  waiting: { glyph: "⏸", label: "等待回复", tone: "waiting" },
  success: { glyph: "◓", label: "待验收", tone: "review" },
  accepted: { glyph: "✓", label: "已验收", tone: "success" },
  rejected: { glyph: "↺", label: "已打回", tone: "rejected" },
  failed: { glyph: "✕", label: "失败", tone: "failed" },
  cancelled: { glyph: "—", label: "已取消", tone: "cancelled" },
  online: { glyph: "●", label: "在线", tone: "success" },
  offline: { glyph: "—", label: "离线", tone: "cancelled" }
};

const TONE_COLOR: Record<Tone, string> = {
  success: "var(--success)",
  running: "var(--running)",
  pending: "var(--pending)",
  failed: "var(--failed)",
  cancelled: "var(--cancelled)",
  queued: "var(--queued)",
  waiting: "var(--waiting)",
  review: "var(--review)",
  rejected: "var(--rejected)"
};

function metaOf(status: string) {
  return STATUS_META[status] ?? { glyph: "·", label: status, tone: "cancelled" as Tone };
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `请求失败：${response.status}`);
  }
}

function fmtTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function fmtAgo(value: string | null): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export default function Dashboard() {
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [history, setHistory] = useState<Record<"online" | "pending" | "running" | "failed", number[]>>({
    online: [],
    pending: [],
    running: [],
    failed: []
  });
  const [message, setMessage] = useState("正在连接数据库…");
  const [synced, setSynced] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const [view, setView] = useState<ViewKey>("dashboard");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [rightMode, setRightMode] = useState<"detail" | "compose">("detail");

  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedWorkerId, setSelectedWorkerId] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadOverview() {
    try {
      const response = await fetch("/api/overview", { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `同步失败：${response.status}`);
      }
      const data = (await response.json()) as Overview;
      setOverview(data);
      setSelectedProjectId((current) => current || data.projects[0]?.id || "");
      setSelectedWorkerId(
        (current) => current || data.workers.find((worker) => worker.status === "online")?.id || ""
      );
      setHistory((prev) => ({
        online: [...prev.online, data.summary.onlineWorkers].slice(-SPARK_CAP),
        pending: [...prev.pending, data.summary.pendingTasks].slice(-SPARK_CAP),
        running: [...prev.running, data.summary.runningTasks].slice(-SPARK_CAP),
        failed: [...prev.failed, data.summary.failedTasks].slice(-SPARK_CAP)
      }));
      setSynced(true);
      setMessage("实时同步中");
      setLastSyncAt(new Date().toISOString());
    } catch (error) {
      setSynced(false);
      setMessage(error instanceof Error ? error.message : "同步失败");
    }
  }

  useEffect(() => {
    void loadOverview();
    const timer = window.setInterval(() => void loadOverview(), 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onlineWorkers = useMemo(
    () => overview.workers.filter((worker) => worker.status === "online"),
    [overview.workers]
  );

  const selectedTask = useMemo(() => {
    if (overview.tasks.length === 0) return null;
    return overview.tasks.find((task) => task.id === selectedTaskId) ?? overview.tasks[0] ?? null;
  }, [overview.tasks, selectedTaskId]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of overview.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, [overview.tasks]);

  function openTask(taskId: string) {
    setSelectedTaskId(taskId);
    setRightMode("detail");
    setDetailTab("overview");
    setView("tasks");
  }

  async function handleProjectSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await postJson("/api/projects", {
        name: data.get("name"),
        repoUrl: data.get("repoUrl"),
        defaultBranch: data.get("defaultBranch"),
        description: data.get("description")
      });
      form.reset();
      await loadOverview();
      setMessage("项目已创建");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "项目创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleTaskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await postJson("/api/tasks", {
        projectId: selectedProjectId,
        title: data.get("title"),
        description: data.get("description"),
        baseBranch: data.get("baseBranch"),
        workBranch: data.get("workBranch"),
        targetFilesText: data.get("targetFilesText"),
        priority: Number(data.get("priority") || 0),
        dependsOn: data.getAll("dependsOn").map(String)
      });
      form.reset();
      await loadOverview();
      setRightMode("detail");
      setMessage("任务已入队");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleCommandSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      await postJson("/api/direct-commands", {
        workerId: selectedWorkerId,
        command: data.get("command"),
        text: data.get("text"),
        cwd: data.get("cwd")
      });
      form.reset();
      await loadOverview();
      setMessage("指令已下发");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "指令下发失败");
    } finally {
      setBusy(false);
    }
  }

  const navItems: { key: ViewKey; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: "dashboard", label: "总览", icon: <LayoutGrid size={18} /> },
    { key: "tasks", label: "任务调度", icon: <ListTodo size={18} />, count: overview.tasks.length },
    { key: "workers", label: "执行机群", icon: <Server size={18} />, count: overview.workers.length },
    { key: "projects", label: "代码项目", icon: <FolderGit2 size={18} />, count: overview.projects.length }
  ];

  const pageMeta: Record<ViewKey, { title: string; sub: string }> = {
    dashboard: { title: "总览", sub: "系统整体态势与健康状态" },
    tasks: { title: "任务调度", sub: "任务流转、PR 跟踪与发布" },
    workers: { title: "执行机群", sub: "Worker 在线状态与定向指挥" },
    projects: { title: "代码项目", sub: "仓库管理与默认分支配置" }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Boxes size={18} />
          </span>
          <span className="brand-text">ClaudeCenter</span>
        </div>

        <div className="nav-section">控制面板</div>
        <nav className="nav">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-item${view === item.key ? " active" : ""}`}
              onClick={() => setView(item.key)}
            >
              <span className="nav-ico">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {typeof item.count === "number" ? <span className="nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="heartbeat">
            <span className={`dot${synced ? " pulse" : ""}`} data-tone={synced ? "online" : "offline"} />
            <span>{synced ? "数据库已连接" : "未连接"}</span>
            <span className="stamp">{lastSyncAt ? fmtAgo(lastSyncAt) : ""}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1 className="page-title">{pageMeta[view].title}</h1>
            <p className="page-sub">{pageMeta[view].sub}</p>
          </div>
          <div className="topbar-actions">
            <span className="sync">
              <RadioTower size={15} />
              <span className="sync-text">{message}</span>
            </span>
          </div>
        </header>

        <div className="view">
          {view === "dashboard" ? (
            <DashboardView
              overview={overview}
              history={history}
              statusCounts={statusCounts}
              onOpenTask={openTask}
            />
          ) : null}

          {view === "tasks" ? (
            <TasksView
              overview={overview}
              selectedTask={selectedTask}
              selectedTaskId={selectedTaskId}
              detailTab={detailTab}
              rightMode={rightMode}
              busy={busy}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSelectTask={(id) => {
                setSelectedTaskId(id);
                setRightMode("detail");
                setDetailTab("overview");
              }}
              onSetTab={setDetailTab}
              onSetRightMode={setRightMode}
              onSubmitTask={handleTaskSubmit}
              onReviewed={loadOverview}
            />
          ) : null}

          {view === "workers" ? (
            <WorkersView
              overview={overview}
              onlineWorkers={onlineWorkers}
              busy={busy}
              selectedWorkerId={selectedWorkerId}
              onSelectWorker={setSelectedWorkerId}
              onSubmitCommand={handleCommandSubmit}
            />
          ) : null}

          {view === "projects" ? (
            <ProjectsView overview={overview} busy={busy} onSubmitProject={handleProjectSubmit} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

/* ============================== Dashboard ============================== */

function DashboardView({
  overview,
  history,
  statusCounts,
  onOpenTask
}: {
  overview: Overview;
  history: Record<"online" | "pending" | "running" | "failed", number[]>;
  statusCounts: Record<string, number>;
  onOpenTask: (id: string) => void;
}) {
  const recentTasks = overview.tasks.slice(0, 7);
  const failedTasks = overview.tasks.filter((task) => task.status === "failed").slice(0, 4);

  const donutSegments = (
    ["running", "waiting", "pending", "claimed", "success", "accepted", "rejected", "failed", "cancelled"] as const
  )
    .map((status) => ({
      status,
      label: metaOf(status).label,
      tone: metaOf(status).tone,
      value: statusCounts[status] ?? 0
    }))
    .filter((segment) => segment.value > 0);
  const donutTotal = donutSegments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <>
      <div className="grid-stats">
        <StatCard
          icon={<Cpu size={16} />}
          label="在线 Worker"
          value={overview.summary.onlineWorkers}
          series={history.online}
          tone="success"
        />
        <StatCard
          icon={<ListTodo size={16} />}
          label="待处理任务"
          value={overview.summary.pendingTasks}
          series={history.pending}
          tone="pending"
        />
        <StatCard
          icon={<Activity size={16} />}
          label="执行中"
          value={overview.summary.runningTasks}
          series={history.running}
          tone="running"
        />
        <StatCard
          icon={<CircleAlert size={16} />}
          label="失败任务"
          value={overview.summary.failedTasks}
          series={history.failed}
          tone="failed"
        />
      </div>

      <div className="grid-2">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <Activity size={16} className="ico" />
                最近任务流
              </h2>
              <span className="card-tools">最新 {recentTasks.length} 条</span>
            </div>
            <div className="card-body flush">
              {recentTasks.length === 0 ? (
                <Empty icon={<Inbox size={28} />} text="暂无任务" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>状态</th>
                        <th>任务</th>
                        <th>分支</th>
                        <th className="t-right">更新</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTasks.map((task) => (
                        <tr key={task.id} onClick={() => onOpenTask(task.id)}>
                          <td>
                            <StatusBadge status={task.status} />
                          </td>
                          <td>
                            <div className="cell-stack">
                              <span className="t-title">{task.title}</span>
                              <span className="t-meta">{task.project_name ?? task.project_id}</span>
                            </div>
                          </td>
                          <td className="mono">{task.work_branch}</td>
                          <td className="t-right t-num">{fmtTime(task.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {failedTasks.length > 0 ? (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">
                  <CircleAlert size={16} className="ico" />
                  异常提示
                </h2>
                <span className="card-tools">{failedTasks.length} 个失败任务</span>
              </div>
              <div className="card-body">
                <div className="kv">
                  {failedTasks.map((task) => (
                    <div className="kv-row" key={task.id} style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                      <div>
                        <div className="t-title" style={{ maxWidth: "none" }}>
                          {task.title}
                        </div>
                        <div className="error-box">{task.error_message ?? "未知错误"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
        </div>

        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <ListTodo size={16} className="ico" />
                任务状态分布
              </h2>
            </div>
            <div className="card-body">
              {donutTotal === 0 ? (
                <Empty icon={<Inbox size={28} />} text="暂无任务" />
              ) : (
                <Donut segments={donutSegments} total={donutTotal} />
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <Server size={16} className="ico" />
                Worker 概览
              </h2>
              <span className="card-tools">
                {overview.summary.onlineWorkers}/{overview.workers.length} 在线
              </span>
            </div>
            <div className="card-body">
              {overview.workers.length === 0 ? (
                <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
              ) : (
                <div className="worker-rows">
                  {overview.workers.slice(0, 6).map((worker) => (
                    <div className="worker-row" key={worker.id}>
                      <StatusDot status={worker.status} pulse={worker.status === "online"} />
                      <span className="v" style={{ color: "var(--text-1)", fontWeight: 600 }}>
                        {worker.name}
                      </span>
                      <span className="v mono" style={{ marginLeft: "auto" }}>
                        {fmtAgo(worker.last_seen_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/* ============================== Tasks ============================== */

function TasksView({
  overview,
  selectedTask,
  selectedTaskId,
  detailTab,
  rightMode,
  busy,
  selectedProjectId,
  onSelectProject,
  onSelectTask,
  onSetTab,
  onSetRightMode,
  onSubmitTask,
  onReviewed
}: {
  overview: Overview;
  selectedTask: Task | null;
  selectedTaskId: string | null;
  detailTab: DetailTab;
  rightMode: "detail" | "compose";
  busy: boolean;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onSelectTask: (id: string) => void;
  onSetTab: (tab: DetailTab) => void;
  onSetRightMode: (mode: "detail" | "compose") => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  onReviewed: () => void | Promise<void>;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">任务流</h2>
          <span className="section-sub">{overview.tasks.length} 个任务 · 点击行查看详情</span>
        </div>
        <button
          type="button"
          className={rightMode === "compose" ? "btn btn-sm" : "btn btn-primary btn-sm"}
          onClick={() => onSetRightMode(rightMode === "compose" ? "detail" : "compose")}
          disabled={overview.projects.length === 0}
        >
          <Plus size={16} />
          {rightMode === "compose" ? "返回详情" : "发布任务"}
        </button>
      </div>

      <div className="grid-tasks">
        <section className="card">
          <div className="card-body flush">
            {overview.tasks.length === 0 ? (
              <Empty icon={<Inbox size={28} />} text="暂无任务，点击右上角发布第一个任务" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>任务</th>
                      <th>分支</th>
                      <th className="t-right">优先级</th>
                      <th className="t-right">更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.tasks.map((task) => (
                      <tr
                        key={task.id}
                        className={selectedTask?.id === task.id ? "selected" : ""}
                        onClick={() => onSelectTask(task.id)}
                      >
                        <td>
                          <StatusBadge status={task.status} />
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span className="t-title">{task.title}</span>
                            <span className="t-meta">
                              {task.project_name ?? task.project_id} · {task.base_branch} → {task.work_branch}
                            </span>
                          </div>
                        </td>
                        <td className="mono">{task.work_branch}</td>
                        <td className="t-right t-num">{task.priority}</td>
                        <td className="t-right t-num">{fmtTime(task.updated_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="col">
          {rightMode === "compose" ? (
            <ComposeTaskCard
              overview={overview}
              busy={busy}
              selectedProjectId={selectedProjectId}
              onSelectProject={onSelectProject}
              onSubmit={onSubmitTask}
            />
          ) : (
            <TaskDetail
              task={selectedTask}
              allTasks={overview.tasks}
              detailTab={detailTab}
              onSetTab={onSetTab}
              onReviewed={onReviewed}
            />
          )}
        </div>
      </div>
    </>
  );
}

function ComposeTaskCard({
  overview,
  busy,
  selectedProjectId,
  onSelectProject,
  onSubmit
}: {
  overview: Overview;
  busy: boolean;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  // 前置任务候选：同项目、未取消（取消的任务无法被验收，选它会导致后置永久阻塞）。
  const dependencyCandidates = overview.tasks.filter(
    (task) => task.project_id === selectedProjectId && task.status !== "cancelled"
  );
  return (
    <section className="card detail">
      <div className="card-head">
        <h2 className="card-title">
          <Send size={16} className="ico" />
          发布任务
        </h2>
      </div>
      <div className="card-body">
        <form className="form" onSubmit={onSubmit}>
          <div className="field">
            <label className="field-label">项目</label>
            <select value={selectedProjectId} onChange={(event) => onSelectProject(event.target.value)} required>
              {overview.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">标题</label>
            <input name="title" placeholder="修复登录按钮状态" required />
          </div>
          <div className="field">
            <label className="field-label">目标</label>
            <textarea name="description" rows={4} placeholder="写清期望行为、约束和验收方式" required />
          </div>
          <div className="form-row">
            <div className="field">
              <label className="field-label">基准分支</label>
              <input name="baseBranch" defaultValue="main" />
            </div>
            <div className="field">
              <label className="field-label">
                工作分支 <span className="field-hint">留空自动生成</span>
              </label>
              <input name="workBranch" placeholder="cc/..." />
            </div>
          </div>
          <div className="field">
            <label className="field-label">
              目标文件 <span className="field-hint">每行一个路径，可留空</span>
            </label>
            <textarea name="targetFilesText" rows={3} placeholder={"src/app.tsx\nsrc/lib/auth.ts"} />
          </div>
          <div className="field">
            <label className="field-label">优先级</label>
            <input name="priority" type="number" defaultValue={0} />
          </div>
          <div className="field">
            <label className="field-label">
              前置任务 <span className="field-hint">同项目，可多选；全部「已验收」后才会被领取</span>
            </label>
            {dependencyCandidates.length === 0 ? (
              <span className="field-hint">该项目暂无可作为前置的任务</span>
            ) : (
              <select name="dependsOn" multiple size={Math.min(6, Math.max(3, dependencyCandidates.length))}>
                {dependencyCandidates.map((task) => (
                  <option key={task.id} value={task.id}>
                    [{metaOf(task.status).label}] {task.title}
                  </option>
                ))}
              </select>
            )}
          </div>
          <button className="btn btn-primary" disabled={busy || overview.projects.length === 0} type="submit">
            <Send size={16} />
            入队
          </button>
        </form>
      </div>
    </section>
  );
}

function TaskDetail({
  task,
  allTasks,
  detailTab,
  onSetTab,
  onReviewed
}: {
  task: Task | null;
  allTasks: Task[];
  detailTab: DetailTab;
  onSetTab: (tab: DetailTab) => void;
  onReviewed: () => void | Promise<void>;
}) {
  if (!task) {
    return (
      <section className="card detail">
        <Empty icon={<Inbox size={28} />} text="选择左侧任务查看详情" />
      </section>
    );
  }

  const timeline: { label: string; time: string | null; state: "done" | "active" | "idle" }[] = [
    { label: "已创建", time: task.created_at, state: "done" },
    {
      label: "已认领",
      time: task.claimed_at,
      state: task.claimed_at ? "done" : "idle"
    },
    {
      label: "开始执行",
      time: task.started_at,
      state: task.started_at ? (task.status === "running" ? "active" : "done") : "idle"
    },
    {
      label:
        task.status === "failed" ? "执行失败" : task.status === "cancelled" ? "已取消" : "执行完成",
      time: task.finished_at,
      state: task.finished_at ? "done" : "idle"
    },
    {
      label:
        task.status === "accepted" ? "已验收" : task.status === "rejected" ? "已打回" : "人工验收",
      time: null,
      state: task.status === "accepted" ? "done" : task.status === "success" ? "active" : "idle"
    }
  ];

  // 前置任务（由 overview 的 depends_on 解析标题；找不到的退化为短 id）。
  const predecessors = (task.depends_on ?? []).map(
    (id) => allTasks.find((candidate) => candidate.id === id) ?? null
  );
  const isBlocked = task.status === "pending" && (task.blocked ?? false);

  const logText =
    [
      task.error_message ? `[error] ${task.error_message}` : "",
      task.result && Object.keys(task.result).length > 0 ? JSON.stringify(task.result, null, 2) : ""
    ]
      .filter(Boolean)
      .join("\n\n") || "暂无日志输出";

  return (
    <section className="card detail">
      <div className="detail-head">
        <h2 className="detail-title">{task.title}</h2>
        <div className="detail-tags">
          <StatusBadge status={task.status} />
          {isBlocked ? <span className="badge" data-tone="pending">⛔ 前置未验收·阻塞中</span> : null}
          <span className="tag">
            <GitBranch size={13} className="ico" />
            {task.base_branch} → {task.work_branch}
          </span>
          {task.pr_url ? (
            <a className="tag" href={task.pr_url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} className="ico" />
              PR
            </a>
          ) : null}
        </div>
      </div>

      <div className="tabs">
        {(["overview", "conversation", "timeline", "logs"] as DetailTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`tab${detailTab === tab ? " active" : ""}`}
            onClick={() => onSetTab(tab)}
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
            {task.status === "success" ? <TaskReviewActions task={task} onReviewed={onReviewed} /> : null}
            <KvRow k="项目" v={task.project_name ?? task.project_id} />
            <KvRow k="描述" v={task.description} />
            <KvRow k="基准分支" v={task.base_branch} mono />
            <KvRow k="工作分支" v={task.work_branch} mono />
            <KvRow k="优先级" v={String(task.priority)} />
            {predecessors.length > 0 ? (
              <KvRow
                k="前置任务"
                v={
                  <div className="pill-row">
                    {predecessors.map((pre, index) =>
                      pre ? (
                        <span className="pill" key={pre.id}>
                          [{metaOf(pre.status).label}] {pre.title}
                        </span>
                      ) : (
                        <span className="pill" key={index}>
                          已删除任务
                        </span>
                      )
                    )}
                  </div>
                }
              />
            ) : null}
            <KvRow
              k="目标文件"
              v={
                task.target_files.length > 0 ? (
                  <div className="pill-row">
                    {task.target_files.map((file) => (
                      <span className="pill" key={file}>
                        {file}
                      </span>
                    ))}
                  </div>
                ) : (
                  "—"
                )
              }
            />
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
            <KvRow k="创建于" v={fmtTime(task.created_at)} />
            <KvRow k="更新于" v={fmtTime(task.updated_at)} />
            {task.error_message ? (
              <div className="error-box">{task.error_message}</div>
            ) : null}
          </div>
        ) : null}

        {detailTab === "timeline" ? (
          <div className="timeline">
            {timeline.map((item, index) => (
              <div className="tl-item" key={index}>
                <span
                  className={`tl-node${item.state === "done" ? " done" : item.state === "active" ? " active" : ""}`}
                />
                <div>
                  <div className="tl-label">{item.label}</div>
                  <div className="tl-time">{item.time ? fmtTime(item.time) : "—"}</div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {detailTab === "conversation" ? <TaskConversation task={task} /> : null}

        {detailTab === "logs" ? <pre className="logs">{logText}</pre> : null}
      </div>
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

function TaskConversation({ task }: { task: Task }) {
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = task.status === "waiting";

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const response = await fetch(`/api/tasks/${task.id}/comments`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { comments: TaskComment[] };
        if (active) setComments(data.comments);
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    }
    void load();
    const timer = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [task.id]);

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
        <Empty icon={<MessageSquare size={28} />} text="暂无对话。Worker 需要确认时会在此提问。" />
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
          placeholder={waiting ? "回复 Worker 的提问，提交后将续接执行…" : "仅在任务「等待回复」时可回复"}
          disabled={!waiting || busy}
        />
        {error ? <div className="error-box">{error}</div> : null}
        <button className="btn btn-primary" type="submit" disabled={!waiting || busy || !reply.trim()}>
          <Send size={16} />
          {waiting ? "回复并续接" : "等待 Worker 提问"}
        </button>
      </form>
    </div>
  );
}

/* ============================== Workers ============================== */

function WorkersView({
  overview,
  onlineWorkers,
  busy,
  selectedWorkerId,
  onSelectWorker,
  onSubmitCommand
}: {
  overview: Overview;
  onlineWorkers: Worker[];
  busy: boolean;
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  onSubmitCommand: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">执行机群</h2>
          <span className="section-sub">
            {overview.summary.onlineWorkers}/{overview.workers.length} 在线 · 心跳 60s 超时判离线
          </span>
        </div>
      </div>

      <div className="grid-2">
        <div className="col">
          {overview.workers.length === 0 ? (
            <section className="card">
              <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
            </section>
          ) : (
            <div className="worker-grid">
              {overview.workers.map((worker) => {
                const currentTask = overview.tasks.find(
                  (task) => task.claimed_by === worker.id && (task.status === "running" || task.status === "claimed")
                );
                return (
                  <article className="worker-card" key={worker.id}>
                    <div className="worker-top">
                      <StatusDot status={worker.status} pulse={worker.status === "online"} />
                      <span className="worker-name">{worker.name}</span>
                      <StatusBadge status={worker.status} />
                    </div>
                    <div className="worker-rows">
                      <div className="worker-row">
                        <Network size={13} className="ico" />
                        <span className="v">{worker.host_name}</span>
                      </div>
                      <div className="worker-row">
                        <Tag size={13} className="ico" />
                        <span className="v mono">v{worker.app_version}</span>
                      </div>
                      <div className="worker-row">
                        <Clock size={13} className="ico" />
                        <span className="v">心跳 {fmtAgo(worker.last_seen_at)}</span>
                      </div>
                      <div className="worker-row">
                        <Activity size={13} className="ico" />
                        <span className="v">{currentTask ? currentTask.title : "空闲"}</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <RadioTower size={16} className="ico" />
                定向指挥
              </h2>
            </div>
            <div className="card-body">
              <form className="form" onSubmit={onSubmitCommand}>
                <div className="field">
                  <label className="field-label">Worker</label>
                  <select value={selectedWorkerId} onChange={(event) => onSelectWorker(event.target.value)} required>
                    {onlineWorkers.map((worker) => (
                      <option key={worker.id} value={worker.id}>
                        {worker.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">类型</label>
                  <select name="command" defaultValue="claude_prompt">
                    <option value="claude_prompt">Claude Prompt</option>
                    <option value="shell">Shell</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">
                    工作目录 <span className="field-hint">可选，本机路径</span>
                  </label>
                  <input name="cwd" placeholder="D:\\src\\example" />
                </div>
                <div className="field">
                  <label className="field-label">指令</label>
                  <textarea name="text" rows={4} placeholder="发送给 Worker 的即时指令" required />
                </div>
                <button className="btn btn-primary" disabled={busy || onlineWorkers.length === 0} type="submit">
                  <Send size={16} />
                  下发
                </button>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <RefreshCw size={16} className="ico" />
                指令回执
              </h2>
              <span className="card-tools">{overview.commands.length} 条</span>
            </div>
            <div className="card-body flush">
              {overview.commands.length === 0 ? (
                <Empty icon={<Inbox size={28} />} text="暂无定向指令" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>状态</th>
                        <th>类型</th>
                        <th>Worker</th>
                        <th className="t-right">时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.commands.map((command) => (
                        <tr key={command.id} style={{ cursor: "default" }}>
                          <td>
                            <StatusBadge status={command.status} />
                          </td>
                          <td className="mono">{command.command}</td>
                          <td>{command.worker_name ?? command.worker_id}</td>
                          <td className="t-right t-num">{fmtTime(command.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/* ============================== Projects ============================== */

function ProjectsView({
  overview,
  busy,
  onSubmitProject
}: {
  overview: Overview;
  busy: boolean;
  onSubmitProject: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">代码项目</h2>
          <span className="section-sub">{overview.projects.length} 个项目</span>
        </div>
      </div>

      <div className="grid-tasks">
        <section className="card">
          <div className="card-body flush">
            {overview.projects.length === 0 ? (
              <Empty icon={<FolderGit2 size={28} />} text="暂无项目，请在右侧创建" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>项目</th>
                      <th>仓库</th>
                      <th>默认分支</th>
                      <th className="t-right">创建于</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.projects.map((project) => (
                      <tr key={project.id} style={{ cursor: "default" }}>
                        <td>
                          <div className="cell-stack">
                            <span className="t-title">{project.name}</span>
                            {project.description ? (
                              <span className="t-meta">{project.description}</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="mono">{project.repo_url}</td>
                        <td>
                          <span className="tag">
                            <GitBranch size={13} className="ico" />
                            {project.default_branch}
                          </span>
                        </td>
                        <td className="t-right t-num">{fmtTime(project.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <div className="col">
          <section className="card detail">
            <div className="card-head">
              <h2 className="card-title">
                <Plus size={16} className="ico" />
                新建项目
              </h2>
            </div>
            <div className="card-body">
              <form className="form" onSubmit={onSubmitProject}>
                <div className="field">
                  <label className="field-label">项目名</label>
                  <input name="name" placeholder="claude-center" required />
                </div>
                <div className="field">
                  <label className="field-label">Git 仓库地址</label>
                  <input name="repoUrl" placeholder="https://github.com/acme/repo.git" required />
                </div>
                <div className="field">
                  <label className="field-label">默认分支</label>
                  <input name="defaultBranch" placeholder="main" defaultValue="main" />
                </div>
                <div className="field">
                  <label className="field-label">描述</label>
                  <textarea name="description" rows={3} placeholder="项目说明" />
                </div>
                <button className="btn btn-primary" disabled={busy} type="submit">
                  <Plus size={16} />
                  创建项目
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/* ============================== Shared bits ============================== */

function StatCard({
  icon,
  label,
  value,
  series,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  series: number[];
  tone: Tone;
}) {
  const prev = series.length >= 2 ? series[series.length - 2] ?? value : value;
  const delta = value - prev;
  return (
    <article className="stat-card">
      <div className="stat-head">
        <span className="ico">{icon}</span>
        {label}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">
        <span className="stat-trend">
          {delta === 0 ? "持平" : delta > 0 ? `↑ ${delta}` : `↓ ${Math.abs(delta)}`}
        </span>
        <Sparkline data={series} tone={tone} />
      </div>
    </article>
  );
}

function Sparkline({ data, tone }: { data: number[]; tone: Tone }) {
  const w = 96;
  const h = 28;
  const color = TONE_COLOR[tone];
  if (data.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1={0} y1={h - 2} x2={w} y2={h - 2} stroke={color} strokeWidth={1.5} opacity={0.4} />
      </svg>
    );
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * w;
    const y = h - 2 - ((value - min) / range) * (h - 6);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const last = points[points.length - 1]!;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}

function Donut({
  segments,
  total
}: {
  segments: { label: string; tone: Tone; value: number; status: string }[];
  total: number;
}) {
  const size = 128;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <div className="donut-center" style={{ width: size, height: size }}>
        <svg className="donut" width={size} height={size}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={stroke}
          />
          {segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const node = (
              <circle
                key={segment.status}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={TONE_COLOR[segment.tone]}
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return node;
          })}
        </svg>
        <div className="donut-total">
          <div className="n">{total}</div>
          <div className="l">任务</div>
        </div>
      </div>
      <div className="legend">
        {segments.map((segment) => (
          <div className="legend-item" key={segment.status}>
            <span className="dot" data-tone={segment.tone} />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-val">{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const meta = metaOf(status);
  return (
    <span className="badge" data-tone={meta.tone}>
      <span className="glyph">{meta.glyph}</span>
      {meta.label}
    </span>
  );
}

function StatusDot({ status, pulse }: { status: string; pulse?: boolean }) {
  const meta = metaOf(status);
  return <span className={`dot${pulse ? " pulse" : ""}`} data-tone={status === "online" ? "online" : meta.tone} />;
}

function KvRow({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className={`kv-v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="empty">
      <span className="ico">{icon}</span>
      {text}
    </div>
  );
}
