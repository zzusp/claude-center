"use client";

import type {
  DirectCommand,
  Permission,
  Project,
  Role,
  SortDir,
  Task,
  TaskComment,
  TaskEvent,
  UserWithProjects,
  Worker
} from "@claude-center/db";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Boxes,
  Bot,
  Check,
  CircleAlert,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Inbox,
  LayoutGrid,
  ListTodo,
  LogOut,
  MessageSquare,
  Network,
  Pencil,
  Plus,
  Power,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Server,
  ShieldCheck,
  Tag,
  Trash2,
  UserRound,
  Users,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Empty, KvRow, StatusBadge, StatusDot, TaskTypeBadge, fmtDateTime, fmtTime, metaOf, postJson, type Tone } from "./shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";

type Health = {
  db: { ok: boolean; latencyMs: number | null; pool: { total: number; idle: number; waiting: number; max: number } };
  scheduler: {
    startedAt: string | null;
    intervalMs: number | null;
    lastTickAt: string | null;
    lastError: string | null;
    lastPromoted: number;
    totalPromoted: number;
    tickCount: number;
    scheduledPending: number;
    ok: boolean;
  };
};

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
  health: Health | null;
};

type ViewKey = "dashboard" | "tasks" | "workers" | "projects" | "users";

// 当前登录用户（由服务端 page.tsx 注入）。permissions 决定 UI 显隐。
type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
};

// 角色标签与可选项（客户端本地副本，避免把 @claude-center/db 的运行时代码打进前端包）。
const ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  publisher: "发布执行",
  commenter: "任务对话",
  viewer: "只读"
};
const ROLE_OPTIONS: Role[] = ["viewer", "commenter", "publisher", "admin"];

const emptyOverview: Overview = {
  projects: [],
  workers: [],
  tasks: [],
  commands: [],
  summary: { onlineWorkers: 0, pendingTasks: 0, runningTasks: 0, failedTasks: 0 },
  health: null
};

const SPARK_CAP = 24;

const TONE_COLOR: Record<Tone, string> = {
  success: "var(--success)",
  merged: "var(--merged)",
  running: "var(--running)",
  pending: "var(--pending)",
  failed: "var(--failed)",
  cancelled: "var(--cancelled)",
  queued: "var(--queued)",
  waiting: "var(--waiting)",
  draft: "var(--draft)",
  scheduled: "var(--scheduled)",
  review: "var(--review)",
  rejected: "var(--rejected)"
};

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

function syncAgo(value: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (s < 2) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  return `${Math.floor(s / 60)} 分钟前`;
}

export default function Dashboard({ currentUser }: { currentUser: CurrentUser }) {
  const isAdmin = currentUser.role === "admin";
  const can = {
    createTask: currentUser.permissions.includes("task.create"),
    comment: currentUser.permissions.includes("task.comment"),
    command: currentUser.permissions.includes("command.create"),
    createProject: currentUser.permissions.includes("project.create"),
    manageUsers: currentUser.permissions.includes("user.manage")
  };

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

  const router = useRouter();
  const [view, setView] = useState<ViewKey>("dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);

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

  usePolling(() => {
    void loadOverview();
  }, []);

  const onlineWorkers = useMemo(
    () => overview.workers.filter((worker) => worker.status === "online"),
    [overview.workers]
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of overview.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, [overview.tasks]);

  function openTask(task: Task) {
    // 任务详情改为独立路由页展示（可分享 / 刷新保留）。
    router.push(`/tasks/${task.id}`);
  }

  function openCompose() {
    setDrawerOpen(true);
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
      setProjectDrawerOpen(false);
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
    // datetime-local 取到的是本地时间（无时区），转 ISO（带时区）再发；留空即非定时任务。
    const scheduledLocal = String(data.get("scheduledAt") ?? "").trim();
    const scheduledAt = scheduledLocal ? new Date(scheduledLocal).toISOString() : undefined;
    setBusy(true);
    try {
      await postJson("/api/tasks", {
        projectId: selectedProjectId,
        taskType: data.get("taskType"),
        title: data.get("title"),
        description: data.get("description"),
        baseBranch: data.get("baseBranch"),
        workBranch: data.get("workBranch"),
        targetBranch: data.get("targetBranch"),
        submitMode: data.get("submitMode"),
        dependsOn: data.getAll("dependsOn").map(String),
        scheduledAt
      });
      form.reset();
      await loadOverview();
      setDrawerOpen(false);
      setMessage(
        scheduledAt ? "已创建定时任务，到点自动进入待处理队列" : "任务已创建为草稿，发布后 Worker 才会认领"
      );
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

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const navItems: { key: ViewKey; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: "dashboard", label: "总览", icon: <LayoutGrid size={18} /> },
    { key: "tasks", label: "任务调度", icon: <ListTodo size={18} />, count: overview.tasks.length },
    { key: "workers", label: "执行机群", icon: <Server size={18} />, count: overview.workers.length },
    { key: "projects", label: "代码项目", icon: <FolderGit2 size={18} />, count: overview.projects.length },
    ...(can.manageUsers ? [{ key: "users" as ViewKey, label: "用户权限", icon: <Users size={18} /> }] : [])
  ];

  const pageMeta: Record<ViewKey, { title: string; sub: string }> = {
    dashboard: { title: "总览", sub: "系统整体态势与健康状态" },
    tasks: { title: "任务调度", sub: "任务流转、PR 跟踪与发布" },
    workers: { title: "执行机群", sub: "Worker 在线状态与定向指挥" },
    projects: { title: "代码项目", sub: "仓库管理与默认分支配置" },
    users: { title: "用户权限", sub: "用户、角色与项目分配管理" }
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
          <div className="user-card">
            <span className="user-avatar">
              <UserRound size={16} />
            </span>
            <div className="user-meta">
              <span className="user-name">{currentUser.displayName || currentUser.username}</span>
              <span className="user-role">{ROLE_LABEL[currentUser.role]}</span>
            </div>
            <button type="button" className="icon-btn" title="登出" onClick={handleLogout}>
              <LogOut size={15} />
            </button>
          </div>
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
            <SyncStatus synced={synced} message={message} lastSyncAt={lastSyncAt} />
          </div>
        </header>

        <div className="view">
          {view === "dashboard" ? (
            <DashboardView
              overview={overview}
              history={history}
              statusCounts={statusCounts}
              synced={synced}
              lastSyncAt={lastSyncAt}
              onOpenTask={openTask}
            />
          ) : null}

          {view === "tasks" ? (
            <TasksView
              overview={overview}
              onOpenTask={openTask}
              onOpenCompose={openCompose}
              canCreateTask={can.createTask}
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
              canCommand={can.command}
            />
          ) : null}

          {view === "projects" ? (
            <ProjectsView
              overview={overview}
              onOpenCompose={() => setProjectDrawerOpen(true)}
              canManageProjects={can.createProject}
            />
          ) : null}

          {view === "users" && can.manageUsers ? <UsersView overview={overview} currentUser={currentUser} /> : null}
        </div>
      </main>

      <TaskDrawer
        open={drawerOpen}
        busy={busy}
        overview={overview}
        selectedProjectId={selectedProjectId}
        onClose={() => setDrawerOpen(false)}
        onSelectProject={setSelectedProjectId}
        onSubmitTask={handleTaskSubmit}
        canCreateTask={can.createTask}
      />

      <ProjectDrawer
        open={projectDrawerOpen}
        busy={busy}
        onClose={() => setProjectDrawerOpen(false)}
        onSubmit={handleProjectSubmit}
      />
    </div>
  );
}

/* ============================== Dashboard ============================== */

function DashboardView({
  overview,
  history,
  statusCounts,
  synced,
  lastSyncAt,
  onOpenTask
}: {
  overview: Overview;
  history: Record<"online" | "pending" | "running" | "failed", number[]>;
  statusCounts: Record<string, number>;
  synced: boolean;
  lastSyncAt: string | null;
  onOpenTask: (task: Task) => void;
}) {
  const recentTasks = overview.tasks.slice(0, 7);
  const failedTasks = overview.tasks.filter((task) => task.status === "failed").slice(0, 4);

  const donutSegments = (
    [
      "running",
      "waiting",
      "pending",
      "scheduled",
      "draft",
      "claimed",
      "success",
      "merged",
      "accepted",
      "rejected",
      "failed",
      "cancelled"
    ] as const
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
          total={overview.workers.length}
          footLabel={`${
            overview.workers.length > 0
              ? Math.round((overview.summary.onlineWorkers / overview.workers.length) * 100)
              : 0
          }% 在线率`}
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

      <RuntimeHealth health={overview.health} synced={synced} lastSyncAt={lastSyncAt} />

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
                        <tr key={task.id} onClick={() => onOpenTask(task)}>
                          <td>
                            <StatusBadge status={task.status} />
                          </td>
                          <td>
                            <div className="cell-stack">
                              <span className="t-title">{task.title}</span>
                              <span className="t-meta">{task.project_name ?? task.project_id}</span>
                            </div>
                          </td>
                          <td className="mono">{task.task_type === "qa" ? "对话" : task.work_branch}</td>
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

type ListResponse = { tasks: Task[]; total: number; page: number; pageSize: number };

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "scheduled", label: "定时待发" },
  { value: "pending", label: "待处理" },
  { value: "claimed", label: "已认领" },
  { value: "running", label: "执行中" },
  { value: "waiting", label: "等待回复" },
  { value: "success", label: "已完成" },
  { value: "merged", label: "已合并" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" }
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

function TasksView({
  overview,
  onOpenTask,
  onOpenCompose,
  canCreateTask
}: {
  overview: Overview;
  onOpenTask: (task: Task) => void;
  onOpenCompose: () => void;
  canCreateTask: boolean;
}) {
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // 列表固定按更新时间排序，方向由「更新」表头切换（默认降序）。
  const [dir, setDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse>({ tasks: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);

  // 关键词 debounce，避免每敲一个字符就发一次请求
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  // 任一筛选条件变化都回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [status, projectId, debouncedQ, dir, pageSize]);

  usePolling(
    async (isActive) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (projectId) params.set("projectId", projectId);
      if (debouncedQ) params.set("q", debouncedQ);
      params.set("dir", dir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      try {
        const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) return;
        const json = (await response.json()) as ListResponse;
        if (isActive()) setData(json);
      } catch {
        /* 轮询失败静默，下次重试 */
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [status, projectId, debouncedQ, dir, page, pageSize]
  );

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  // 结果收窄导致当前页越界时回拉到末页
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const hasFilter = Boolean(status || projectId || debouncedQ);

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">任务流</h2>
          <span className="section-sub">{data.total} 个任务 · 点击行查看详情</span>
        </div>
        {canCreateTask ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onOpenCompose}
            disabled={overview.projects.length === 0}
          >
            <Plus size={16} />
            发布任务
          </button>
        ) : null}
      </div>

      <section className="card">
        <div className="toolbar">
          <div className="tb-search">
            <Search size={15} className="ico" />
            <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索标题或工作分支" />
          </div>
          <Select
            className="tb-select"
            value={status}
            onChange={setStatus}
            options={STATUS_FILTERS}
            ariaLabel="按状态筛选"
          />
          <Select
            className="tb-select"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: "", label: "全部项目" },
              ...overview.projects.map((project) => ({ value: project.id, label: project.name }))
            ]}
            ariaLabel="按项目筛选"
          />
        </div>

        <div className="card-body flush">
          {data.tasks.length === 0 ? (
            <Empty
              icon={<Inbox size={28} />}
              text={loading ? "加载中…" : hasFilter ? "没有符合条件的任务" : "暂无任务，点击右上角发布第一个任务"}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>任务</th>
                    <th>项目</th>
                    <th>类型</th>
                    <th>分支</th>
                    <th
                      className="t-right"
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => setDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                      title="点击切换更新时间排序"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        更新
                        {dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((task) => (
                    <tr key={task.id} onClick={() => onOpenTask(task)}>
                      <td>
                        <StatusBadge status={task.status} />
                      </td>
                      <td>
                        <span className="t-title">{task.title}</span>
                      </td>
                      <td className="t-meta">{task.project_name ?? task.project_id}</td>
                      <td>
                        <TaskTypeBadge type={task.task_type} />
                      </td>
                      <td className="mono">{task.task_type === "qa" ? "对话" : task.work_branch}</td>
                      <td className="t-right t-num">{fmtDateTime(task.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {data.total > 0 ? (
          <div className="pager">
            <span className="pager-info">
              第 {Math.min(page, totalPages)} / {totalPages} 页 · 共 {data.total} 条
            </span>
            <div className="pager-controls">
              <Select
                className="pager-select"
                value={String(pageSize)}
                onChange={(value) => setPageSize(Number(value))}
                options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `每页 ${size} 条` }))}
                ariaLabel="每页条数"
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                <ChevronLeft size={16} />
                上一页
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              >
                下一页
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}

function ComposeTaskForm({
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
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [taskType, setTaskType] = useState<"work" | "qa">("work");
  const [submitMode, setSubmitMode] = useState<"pr" | "push">("pr");
  const isQa = taskType === "qa";

  useEffect(() => {
    if (!selectedProjectId) {
      setBranches([]);
      setBranchState("idle");
      return;
    }
    let active = true;
    setBranchState("loading");
    fetch(`/api/projects/${selectedProjectId}/branches`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { branches: string[] };
        if (active) {
          setBranches(data.branches);
          setBranchState("idle");
        }
      })
      .catch(() => {
        if (active) {
          setBranches([]);
          setBranchState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId]);

  const branchHint =
    branchState === "loading"
      ? "拉取分支中…"
      : branchState === "error"
        ? "拉取失败，可手填"
        : branches.length > 0
          ? `${branches.length} 个远程分支`
          : "可手动输入";

  // 前置任务候选：同项目、未取消（取消的任务无法被验收，选它会导致后置永久阻塞）。
  const dependencyCandidates = overview.tasks.filter(
    (task) => task.project_id === selectedProjectId && task.status !== "cancelled"
  );

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label">类型</label>
        <Select
          name="taskType"
          value={taskType}
          onChange={(value) => setTaskType(value as "work" | "qa")}
          options={[
            { value: "work", label: "工作类 · 改代码并开 PR" },
            { value: "qa", label: "问答类 · 纯对话不碰 git" }
          ]}
          ariaLabel="任务类型"
        />
      </div>
      <div className="field">
        <label className="field-label">项目</label>
        <Select
          value={selectedProjectId}
          onChange={onSelectProject}
          options={overview.projects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="选择项目"
          ariaLabel="项目"
        />
      </div>
      <div className="field">
        <label className="field-label">标题</label>
        <input name="title" placeholder={isQa ? "心跳间隔是多少？" : "修复登录按钮状态"} required />
      </div>
      <div className="field">
        <label className="field-label">{isQa ? "问题" : "目标"}</label>
        <textarea
          name="description"
          rows={4}
          placeholder={isQa ? "向 Claude 提出关于该项目的问题" : "写清期望行为、约束和验收方式"}
          required
        />
      </div>
      {isQa ? null : (
        <>
          <div className="form-row">
            <div className="field">
              <label className="field-label">
                签出分支 <span className="field-hint">{branchHint}</span>
              </label>
              <input name="baseBranch" list="cc-branch-list" defaultValue="main" placeholder="main" />
            </div>
            <div className="field">
              <label className="field-label">
                PR 目标分支 <span className="field-hint">留空同签出分支</span>
              </label>
              <input name="targetBranch" list="cc-branch-list" placeholder="main" />
            </div>
          </div>
          <datalist id="cc-branch-list">
            {branches.map((branch) => (
              <option key={branch} value={branch} />
            ))}
          </datalist>
          <div className="form-row">
            <div className="field">
              <label className="field-label">
                工作分支 <span className="field-hint">留空自动生成</span>
              </label>
              <input name="workBranch" placeholder="cc/..." />
            </div>
            <div className="field">
              <label className="field-label">提交模式</label>
              <Select
                name="submitMode"
                value={submitMode}
                onChange={(value) => setSubmitMode(value as "pr" | "push")}
                options={[
                  { value: "pr", label: "创建 PR" },
                  { value: "push", label: "直接提交推送" }
                ]}
                ariaLabel="提交模式"
              />
            </div>
          </div>
        </>
      )}
      <div className="field">
        <label className="field-label">
          定时发布 <span className="field-hint">留空即建为草稿手动发布；设定时间则到点自动进入待处理队列</span>
        </label>
        <input name="scheduledAt" type="datetime-local" />
      </div>
      <div className="field">
        <label className="field-label">
          前置任务 <span className="field-hint">同项目，可多选；前置全部「已验收 / 已合并」后才会被领取</span>
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
        {isQa ? "发起问答" : "入队"}
      </button>
    </form>
  );
}

// 通用右侧抽屉外壳：backdrop + 滑入面板 + 头部标题/关闭 + 滚动内容区，Esc 关闭。
// 任务发布、新建项目、用户编辑等表单统一套用，保证三处列表的「点击 → 右侧抽屉」交互一致。
function Drawer({
  open,
  title,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-backdrop${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h2 className="detail-title">{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-scroll drawer-pad">{children}</div>
      </aside>
    </>
  );
}

function TaskDrawer({
  open,
  busy,
  overview,
  selectedProjectId,
  onClose,
  onSelectProject,
  onSubmitTask,
  canCreateTask
}: {
  open: boolean;
  busy: boolean;
  overview: Overview;
  selectedProjectId: string;
  onClose: () => void;
  onSelectProject: (id: string) => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  canCreateTask: boolean;
}) {
  // 仅用于「发布任务」表单；任务详情已迁至独立路由页 /tasks/[id]。
  return (
    <Drawer open={open} title={canCreateTask ? "发布任务" : ""} onClose={onClose}>
      {canCreateTask ? (
        <ComposeTaskForm
          overview={overview}
          busy={busy}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onSubmit={onSubmitTask}
        />
      ) : null}
    </Drawer>
  );
}

function ProjectDrawer({
  open,
  busy,
  onClose,
  onSubmit
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Drawer open={open} title="新建项目" onClose={onClose}>
      <form className="form" onSubmit={onSubmit}>
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
    </Drawer>
  );
}

/* ============================== Workers ============================== */

function WorkersView({
  overview,
  onlineWorkers,
  busy,
  selectedWorkerId,
  onSelectWorker,
  onSubmitCommand,
  canCommand
}: {
  overview: Overview;
  onlineWorkers: Worker[];
  busy: boolean;
  selectedWorkerId: string;
  onSelectWorker: (id: string) => void;
  onSubmitCommand: (event: FormEvent<HTMLFormElement>) => void;
  canCommand: boolean;
}) {
  const [command, setCommand] = useState<"claude_prompt" | "shell">("claude_prompt");

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

        {canCommand ? (
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
                  <Select
                    value={selectedWorkerId}
                    onChange={onSelectWorker}
                    options={onlineWorkers.map((worker) => ({ value: worker.id, label: worker.name }))}
                    placeholder="选择 Worker"
                    ariaLabel="Worker"
                  />
                </div>
                <div className="field">
                  <label className="field-label">类型</label>
                  <Select
                    name="command"
                    value={command}
                    onChange={(value) => setCommand(value as "claude_prompt" | "shell")}
                    options={[
                      { value: "claude_prompt", label: "Claude Prompt" },
                      { value: "shell", label: "Shell" }
                    ]}
                    ariaLabel="指令类型"
                  />
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
        ) : null}
      </div>
    </>
  );
}

/* ============================== Projects ============================== */

function ProjectsView({
  overview,
  onOpenCompose,
  canManageProjects
}: {
  overview: Overview;
  onOpenCompose: () => void;
  canManageProjects: boolean;
}) {
  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">代码项目</h2>
          <span className="section-sub">{overview.projects.length} 个项目</span>
        </div>
        {canManageProjects ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onOpenCompose}>
            <Plus size={16} />
            新建项目
          </button>
        ) : null}
      </div>

      <section className="card">
        <div className="card-body flush">
          {overview.projects.length === 0 ? (
            <Empty
              icon={<FolderGit2 size={28} />}
              text={canManageProjects ? "暂无项目，点击右上角新建项目" : "暂无可访问的项目"}
            />
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
    </>
  );
}

/* ============================== Shared bits ============================== */

function SyncStatus({
  synced,
  message,
  lastSyncAt
}: {
  synced: boolean;
  message: string;
  lastSyncAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ago = synced && lastSyncAt ? syncAgo(lastSyncAt, now) : null;

  return (
    <span className="sync" data-live={synced ? "on" : "off"}>
      <span className={`dot${synced ? " pulse" : ""}`} data-tone={synced ? "online" : "offline"} />
      <span className="sync-text">{message}</span>
      {ago ? (
        <span className="sync-ago" key={lastSyncAt}>
          · {ago}
        </span>
      ) : null}
    </span>
  );
}

function RuntimeHealth({
  health,
  synced,
  lastSyncAt
}: {
  health: Health | null;
  synced: boolean;
  lastSyncAt: string | null;
}) {
  const db = health?.db;
  const sched = health?.scheduler;
  const intervalSec = sched?.intervalMs ? Math.round(sched.intervalMs / 1000) : null;

  return (
    <section className="health-section">
      <div className="section-head">
        <h2 className="section-title">系统运行状态</h2>
        <span className="section-sub">数据库 · 调度器 · 实时同步</span>
      </div>
      <div className="grid-3">
        <HealthCard
          icon={<Database size={16} />}
          title="数据库连接"
          ok={db?.ok ?? false}
          okLabel={db?.ok ? "已连接" : "未连接"}
          rows={[
            { k: "往返延迟", v: db?.latencyMs != null ? `${db.latencyMs} ms` : "—" },
            { k: "连接池", v: db ? `${db.pool.total} / ${db.pool.max}（空闲 ${db.pool.idle}）` : "—" },
            { k: "等待队列", v: db ? `${db.pool.waiting}` : "—" }
          ]}
        />
        <HealthCard
          icon={<Clock size={16} />}
          title="定时调度器"
          ok={sched?.ok ?? false}
          okLabel={sched?.ok ? "运行中" : sched?.startedAt ? "异常" : "未启动"}
          rows={[
            { k: "检查周期", v: intervalSec != null ? `每 ${intervalSec}s` : "—" },
            { k: "上次检查", v: sched?.lastTickAt ? fmtAgo(sched.lastTickAt) : "—" },
            { k: "定时待发", v: sched ? `${sched.scheduledPending} 个` : "—" },
            { k: "累计提升", v: sched ? `${sched.totalPromoted} 个` : "—" },
            ...(sched?.lastError ? [{ k: "最近错误", v: sched.lastError, mono: true }] : [])
          ]}
        />
        <HealthCard
          icon={<RadioTower size={16} />}
          title="实时同步"
          ok={synced}
          okLabel={synced ? "同步中" : "已断开"}
          rows={[
            { k: "轮询节奏", v: `每 ${Math.round(POLL_INTERVAL_MS / 1000)}s` },
            { k: "上次同步", v: lastSyncAt ? fmtAgo(lastSyncAt) : "—" }
          ]}
        />
      </div>
    </section>
  );
}

function HealthCard({
  icon,
  title,
  ok,
  okLabel,
  rows
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean;
  okLabel: string;
  rows: { k: string; v: React.ReactNode; mono?: boolean }[];
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <span className="ico">{icon}</span>
          {title}
        </h2>
        <span className="badge" data-tone={ok ? "success" : "failed"}>
          <span className="glyph">{ok ? "●" : "✕"}</span>
          {okLabel}
        </span>
      </div>
      <div className="card-body health-body">
        {rows.map((row) => (
          <KvRow key={row.k} k={row.k} v={row.v} mono={row.mono} />
        ))}
      </div>
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  total,
  footLabel,
  series,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  total?: number;
  footLabel?: string;
  series: number[];
  tone: Tone;
}) {
  const prev = series.length >= 2 ? series[series.length - 2] ?? value : value;
  const delta = value - prev;
  const trend = delta === 0 ? "较昨日 持平" : `较昨日 ${delta > 0 ? "+" : "-"}${Math.abs(delta)}`;
  return (
    <article className="stat-card">
      <div className="stat-head">
        <span className="ico" style={{ color: TONE_COLOR[tone] }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="stat-value">
        {value}
        {typeof total === "number" ? <span className="unit">/ {total}</span> : null}
      </div>
      <div className="stat-foot">
        <span className="stat-trend">{footLabel ?? trend}</span>
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

/* ============================== Users ============================== */

type EditableUser = UserWithProjects;

function UsersView({ overview, currentUser }: { overview: Overview; currentUser: CurrentUser }) {
  const [users, setUsers] = useState<EditableUser[]>([]);
  const [editing, setEditing] = useState<EditableUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadUsers() {
    try {
      const response = await fetch("/api/users", { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `加载失败：${response.status}`);
      }
      const data = (await response.json()) as { users: EditableUser[] };
      setUsers(data.users);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of overview.projects) map.set(project.id, project.name);
    return map;
  }, [overview.projects]);

  async function handleDelete(user: EditableUser) {
    if (!window.confirm(`确认删除用户「${user.username}」？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `删除失败：${response.status}`);
      }
      await loadUsers();
      setMessage(`已删除 ${user.username}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleDisabled(user: EditableUser) {
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !user.disabled })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `操作失败：${response.status}`);
      }
      await loadUsers();
      setMessage(`${user.username} 已${user.disabled ? "启用" : "停用"}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">用户权限</h2>
          <span className="section-sub">
            {users.length} 个用户{message ? ` · ${message}` : ""}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          <Plus size={16} />
          新建用户
        </button>
      </div>

      <section className="card">
        <div className="card-body flush">
          {users.length === 0 ? (
            <Empty icon={<Users size={28} />} text="暂无用户" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>角色</th>
                    <th>项目</th>
                    <th className="t-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className={editing?.id === user.id ? "selected" : ""}
                      onClick={() => {
                        setEditing(user);
                        setCreating(false);
                      }}
                    >
                      <td>
                        <div className="cell-stack">
                          <span className="t-title">
                            {user.display_name || user.username}
                            {user.id === currentUser.id ? <span className="self-tag">本人</span> : null}
                          </span>
                          <span className="t-meta mono">{user.username}</span>
                        </div>
                      </td>
                      <td>
                        <span className="role-badge" data-role={user.role}>
                          <ShieldCheck size={12} className="ico" />
                          {ROLE_LABEL[user.role]}
                        </span>
                      </td>
                      <td>
                        {user.role === "admin" ? (
                          <span className="t-meta">全部项目</span>
                        ) : user.project_ids.length === 0 ? (
                          <span className="t-meta">—</span>
                        ) : (
                          <span className="t-meta">
                            {user.project_ids.map((id) => projectName.get(id) ?? id).join("、")}
                          </span>
                        )}
                      </td>
                      <td className="t-right">
                        <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                          <button
                            type="button"
                            className="icon-btn"
                            title={user.disabled ? "启用" : "停用"}
                            disabled={busy || user.id === currentUser.id}
                            onClick={() => handleToggleDisabled(user)}
                          >
                            <Power size={14} data-tone={user.disabled ? "off" : "on"} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="编辑"
                            onClick={() => {
                              setEditing(user);
                              setCreating(false);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="删除"
                            disabled={busy || user.id === currentUser.id}
                            onClick={() => handleDelete(user)}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Drawer
        open={creating || editing !== null}
        title={creating ? "新建用户" : editing ? `编辑 ${editing.username}` : ""}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      >
        {creating ? (
          <UserForm
            mode="create"
            projects={overview.projects}
            onDone={async (note) => {
              setCreating(false);
              setMessage(note);
              await loadUsers();
            }}
          />
        ) : editing ? (
          <UserForm
            mode="edit"
            key={editing.id}
            user={editing}
            projects={overview.projects}
            onDone={async (note) => {
              setEditing(null);
              setMessage(note);
              await loadUsers();
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}

function UserForm({
  mode,
  user,
  projects,
  onDone
}: {
  mode: "create" | "edit";
  user?: EditableUser;
  projects: Project[];
  onDone: (note: string) => void | Promise<void>;
}) {
  const [role, setRole] = useState<Role>(user?.role ?? "viewer");
  const [projectIds, setProjectIds] = useState<string[]>(user?.project_ids ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleProject(id: string) {
    setProjectIds((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get("username") ?? "").trim();
    const password = String(data.get("password") ?? "");
    const displayName = String(data.get("displayName") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const response = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, displayName, role, projectIds: role === "admin" ? [] : projectIds })
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `创建失败：${response.status}`);
        }
        await onDone(`已创建用户 ${username}`);
      } else if (user) {
        const body: Record<string, unknown> = {
          role,
          displayName,
          projectIds: role === "admin" ? [] : projectIds
        };
        if (password) body.password = password;
        const response = await fetch(`/api/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `保存失败：${response.status}`);
        }
        await onDone(`已更新用户 ${user.username}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label">用户名</label>
        <input name="username" defaultValue={user?.username ?? ""} placeholder="zhang.san" required disabled={mode === "edit"} />
      </div>
      <div className="field">
        <label className="field-label">显示名</label>
        <input name="displayName" defaultValue={user?.display_name ?? ""} placeholder="张三" />
      </div>
      <div className="field">
        <label className="field-label">
          密码 {mode === "edit" ? <span className="field-hint">留空表示不修改</span> : null}
        </label>
        <input name="password" type="password" placeholder={mode === "create" ? "初始密码" : "重置为新密码"} required={mode === "create"} />
      </div>
      <div className="field">
        <label className="field-label">角色</label>
        <Select
          value={role}
          onChange={(value) => setRole(value as Role)}
          options={ROLE_OPTIONS.map((value) => ({ value, label: ROLE_LABEL[value] }))}
          ariaLabel="角色"
        />
      </div>
      {role === "admin" ? (
        <div className="field">
          <label className="field-label">项目范围</label>
          <div className="scope-hint">管理员可访问全部项目，无需分配。</div>
        </div>
      ) : (
        <div className="field">
          <label className="field-label">
            可访问项目 <span className="field-hint">勾选分配给该用户的项目</span>
          </label>
          {projects.length === 0 ? (
            <div className="scope-hint">暂无项目，先到「代码项目」创建。</div>
          ) : (
            <div className="checkbox-list">
              {projects.map((project) => (
                <label key={project.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(project.id)}
                    onChange={() => toggleProject(project.id)}
                  />
                  <span>{project.name}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      {error ? <div className="error-box">{error}</div> : null}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {mode === "create" ? <Plus size={16} /> : <Save size={16} />}
        {mode === "create" ? "创建用户" : "保存修改"}
      </button>
    </form>
  );
}

/* ============================== Select ==============================
   自定义单选下拉：用 div 渲染展开面板，圆角 / 阴影 / hover / 选中态全部受控，
   与 Claude Light 设计系统统一（原生 <select> 的弹出面板无法 CSS 定制）。
   带 name 时渲染隐藏 input，保持 FormData 取值不变。 */

type SelectOption = { value: string; label: string };

function Select({
  value,
  onChange,
  options,
  name,
  className,
  placeholder,
  required,
  disabled,
  ariaLabel
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  name?: string;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  // 点击组件外部时收起面板
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // 打开时把键盘高亮对齐到当前选中项
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, selectedIndex]);

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(options.length - 1, prev + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    }
  }

  return (
    <div className={`cc-select${open ? " open" : ""}${className ? ` ${className}` : ""}`} ref={rootRef}>
      {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
      <button
        type="button"
        className="cc-select-trigger"
        onClick={() => (disabled ? undefined : setOpen((prev) => !prev))}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={`cc-select-label${selected ? "" : " placeholder"}`}>
          {selected ? selected.label : placeholder ?? ""}
        </span>
        <ChevronDown size={15} className="cc-select-caret" aria-hidden />
      </button>
      {open ? (
        <div className="cc-select-panel" role="listbox">
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={`cc-select-option${option.value === value ? " selected" : ""}${
                index === activeIndex ? " active" : ""
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="cc-select-option-label">{option.label}</span>
              {option.value === value ? <Check size={14} className="cc-select-check" aria-hidden /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
