"use client";

import {
  Boxes, FolderGit2, LayoutGrid, ListTodo, LogOut, MessageSquare, Server, UserRound, Users
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABEL, type CurrentUser } from "./dashboard-shared";

type NavItem = { href: string; label: string; icon: ReactNode; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "总览", icon: <LayoutGrid size={16} strokeWidth={1.5} /> },
  { href: "/tasks", label: "任务调度", icon: <ListTodo size={16} strokeWidth={1.5} /> },
  { href: "/chat", label: "实时对话", icon: <MessageSquare size={16} strokeWidth={1.5} /> },
  { href: "/workers", label: "执行机群", icon: <Server size={16} strokeWidth={1.5} /> },
  { href: "/projects", label: "代码项目", icon: <FolderGit2 size={16} strokeWidth={1.5} /> },
  { href: "/users", label: "用户权限", icon: <Users size={16} strokeWidth={1.5} />, adminOnly: true }
];

// 全站外壳：仅侧边栏 + 主内容区。页面标题由各页 section-head 渲染，topbar 已下线避免两层 header。
export default function Shell({ currentUser, children }: { currentUser: CurrentUser; children: ReactNode }) {
  const canManageUsers = currentUser.permissions.includes("user.manage");
  const pathname = usePathname();

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
