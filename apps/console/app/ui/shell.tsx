"use client";

import {
  Boxes, FolderGit2, LayoutGrid, ListTodo, LogOut, MessageSquare, Server, UserRound, Users
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { ReactNode } from "react";
import { ROLE_LABEL, type CurrentUser } from "./dashboard-shared";
import { usePolling } from "../lib/use-polling";

type Counts = { tasks: number; workers: number; projects: number };

const EMPTY_COUNTS: Counts = { tasks: 0, workers: 0, projects: 0 };

type NavItem = { href: string; label: string; icon: ReactNode; countKey?: keyof Counts; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "总览", icon: <LayoutGrid size={20} /> },
  { href: "/tasks", label: "任务调度", icon: <ListTodo size={20} />, countKey: "tasks" },
  { href: "/chat", label: "实时对话", icon: <MessageSquare size={20} /> },
  { href: "/workers", label: "执行机群", icon: <Server size={20} />, countKey: "workers" },
  { href: "/projects", label: "代码项目", icon: <FolderGit2 size={20} />, countKey: "projects" },
  { href: "/users", label: "用户权限", icon: <Users size={20} />, adminOnly: true }
];

// 全站外壳：仅侧边栏 + 主内容区。页面标题由各页 section-head 渲染，topbar 已下线避免两层 header。
// /api/summary 轮询只用于维持侧栏徽标计数。
export default function Shell({ currentUser, children }: { currentUser: CurrentUser; children: ReactNode }) {
  const canManageUsers = currentUser.permissions.includes("user.manage");
  const pathname = usePathname();

  const [counts, setCounts] = useState<Counts>(EMPTY_COUNTS);

  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/summary", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { counts: Counts };
      if (!isActive()) return;
      setCounts(data.counts);
    } catch {
      /* 轮询失败静默 */
    }
  }, [], 15000);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  }

  const navItems = NAV.filter((item) => !item.adminOnly || canManageUsers);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Boxes size={18} />
          </span>
          <span className="brand-text">ClaudeCenter</span>
        </div>

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
          <div className="user-card" tabIndex={0}>
            <span className="user-avatar">
              <UserRound size={20} />
            </span>
            <div className="user-meta">
              <span className="user-name">{currentUser.displayName || currentUser.username}</span>
              <span className="user-role">{ROLE_LABEL[currentUser.role]}</span>
            </div>
            <div className="user-menu" role="menu">
              <button type="button" className="user-menu-item" role="menuitem" onClick={handleLogout}>
                <LogOut size={14} />
                <span>登出</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="view">{children}</div>
      </main>
    </div>
  );
}
