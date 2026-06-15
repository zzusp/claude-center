"use client";

import {
  Boxes, FolderGit2, LayoutGrid, ListTodo, LogOut, MessageSquare, Server, UserRound, Users
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { SyncStatus } from "./overview";
import { ROLE_LABEL, fmtAgo, type CurrentUser } from "./dashboard-shared";
import { usePolling } from "../lib/use-polling";

type Counts = { tasks: number; workers: number; projects: number };

const EMPTY_COUNTS: Counts = { tasks: 0, workers: 0, projects: 0 };

type NavItem = { href: string; label: string; icon: ReactNode; countKey?: keyof Counts; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "总览", icon: <LayoutGrid size={18} /> },
  { href: "/tasks", label: "任务调度", icon: <ListTodo size={18} />, countKey: "tasks" },
  { href: "/chat", label: "实时对话", icon: <MessageSquare size={18} /> },
  { href: "/workers", label: "执行机群", icon: <Server size={18} />, countKey: "workers" },
  { href: "/projects", label: "代码项目", icon: <FolderGit2 size={18} />, countKey: "projects" },
  { href: "/users", label: "用户权限", icon: <Users size={18} />, adminOnly: true }
];

const DEFAULT_PAGE_META = { title: "总览", sub: "系统整体态势与健康状态" };

const PAGE_META: Record<string, { title: string; sub: string }> = {
  "/": DEFAULT_PAGE_META,
  "/tasks": { title: "任务调度", sub: "任务流转、PR 跟踪与发布" },
  "/chat": { title: "实时对话", sub: "指定项目分支 + 指定 Worker 实时对话，独立于任务流" },
  "/workers": { title: "执行机群", sub: "Worker 在线状态与心跳，点击卡片查看详情" },
  "/projects": { title: "代码项目", sub: "仓库管理与默认分支配置" },
  "/users": { title: "用户权限", sub: "用户、角色与项目分配管理" }
};

// 全站外壳：侧边栏 + topbar。自轮询 /api/summary 维持徽标计数与心跳（跨页保持新鲜）；
// 当前页由 usePathname 决定，取代旧的 ?view= 客户端切换。各菜单页作为 children 渲染。
export default function Shell({ currentUser, children }: { currentUser: CurrentUser; children: ReactNode }) {
  const canManageUsers = currentUser.permissions.includes("user.manage");
  const pathname = usePathname();

  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);
  const [synced, setSynced] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [message, setMessage] = useState("正在连接数据库…");

  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/summary", { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `同步失败：${response.status}`);
      }
      const data = (await response.json()) as { counts: Counts };
      if (!isActive()) return;
      setCounts(data.counts);
      setSynced(true);
      setMessage("实时同步中");
      setLastSyncAt(new Date().toISOString());
    } catch (error) {
      if (!isActive()) return;
      setSynced(false);
      setMessage(error instanceof Error ? error.message : "同步失败");
    }
  }, []);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const navItems = NAV.filter((item) => !item.adminOnly || canManageUsers);
  const meta = PAGE_META[pathname] ?? DEFAULT_PAGE_META;

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
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${pathname === item.href ? " active" : ""}`}
            >
              <span className="nav-ico">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.countKey ? <span className="nav-count">{counts[item.countKey]}</span> : null}
            </Link>
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
            <h1 className="page-title">{meta.title}</h1>
            <p className="page-sub">{meta.sub}</p>
          </div>
          <div className="topbar-actions">
            <SyncStatus synced={synced} message={message} lastSyncAt={lastSyncAt} />
          </div>
        </header>

        <div className="view">{children}</div>
      </main>
    </div>
  );
}
