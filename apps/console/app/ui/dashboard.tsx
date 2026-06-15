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
  Activity, ArrowDown, ArrowUp, Boxes, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type Overview, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { DashboardView, SyncStatus } from "./overview";
import { ChatView } from "./chat";
import { TasksView, TaskDrawer } from "./tasks";
import { WorkersView } from "./workers";
import { ProjectsView } from "./projects";
import { UsersView } from "./users";

const VIEW_KEYS: ViewKey[] = ["dashboard", "tasks", "chat", "workers", "projects", "users"];

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
  const searchParams = useSearchParams();
  // 当前标签持久化到 URL（?view=tasks），从任务详情 router.back() 回来后能恢复到来源标签，
  // 否则 Dashboard 重新挂载会把 view 重置成 dashboard（总览）。
  const [view, setView] = useState<ViewKey>(() => {
    const v = searchParams.get("view");
    if (v && (VIEW_KEYS as string[]).includes(v) && (v !== "users" || can.manageUsers)) {
      return v as ViewKey;
    }
    return "dashboard";
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  function selectView(key: ViewKey) {
    setView(key);
    // 用 history API 改 URL：只更新当前历史记录、不触发服务端重渲染；back 时即可被 useSearchParams 读回。
    window.history.replaceState(null, "", key === "dashboard" ? "/" : `/?view=${key}`);
  }

  const [selectedProjectId, setSelectedProjectId] = useState("");
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
        title: data.get("title"),
        description: data.get("description"),
        baseBranch: data.get("baseBranch"),
        workBranch: data.get("workBranch"),
        targetBranch: data.get("targetBranch"),
        submitMode: data.get("submitMode"),
        autoMergePr: data.get("autoMergePr") === "on",
        model: data.get("model"),
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
    { key: "chat", label: "对话", icon: <MessageSquare size={18} /> },
    { key: "workers", label: "执行机群", icon: <Server size={18} />, count: overview.workers.length },
    { key: "projects", label: "代码项目", icon: <FolderGit2 size={18} />, count: overview.projects.length },
    ...(can.manageUsers ? [{ key: "users" as ViewKey, label: "用户权限", icon: <Users size={18} /> }] : [])
  ];

  const pageMeta: Record<ViewKey, { title: string; sub: string }> = {
    dashboard: { title: "总览", sub: "系统整体态势与健康状态" },
    tasks: { title: "任务调度", sub: "任务流转、PR 跟踪与发布" },
    chat: { title: "对话", sub: "指定项目分支 + 指定 Worker 实时对话，独立于任务流" },
    workers: { title: "执行机群", sub: "Worker 在线状态与心跳，点击卡片查看详情" },
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
              onClick={() => selectView(item.key)}
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

          {view === "chat" ? <ChatView overview={overview} canCommand={can.command} /> : null}

          {view === "workers" ? (
            <WorkersView overview={overview} canCommand={can.command} onChanged={loadOverview} />
          ) : null}

          {view === "projects" ? (
            <ProjectsView
              overview={overview}
              onChanged={loadOverview}
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

    </div>
  );
}
