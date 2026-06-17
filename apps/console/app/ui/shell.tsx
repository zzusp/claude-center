"use client";

import {
  Boxes, FolderGit2, LayoutGrid, ListTodo, LogOut, MessageSquare, Server, UserRound, Users
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ROLE_LABEL, type CurrentUser } from "./dashboard-shared";
import Notifications from "./notifications";

type NavItem = { href: string; label: string; icon: ReactNode; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/", label: "总览", icon: <LayoutGrid size={16} strokeWidth={1.5} /> },
  { href: "/tasks", label: "任务调度", icon: <ListTodo size={16} strokeWidth={1.5} /> },
  { href: "/chat", label: "实时对话", icon: <MessageSquare size={16} strokeWidth={1.5} /> },
  { href: "/workers", label: "执行机群", icon: <Server size={16} strokeWidth={1.5} /> },
  { href: "/projects", label: "代码项目", icon: <FolderGit2 size={16} strokeWidth={1.5} /> },
  { href: "/users", label: "用户权限", icon: <Users size={16} strokeWidth={1.5} />, adminOnly: true }
];

// 系统 header 标题映射：按最长前缀匹配（详情子路由复用父级标题）。
const PAGE_META: { match: (pathname: string) => boolean; title: string; sub: string }[] = [
  { match: (p) => p === "/", title: "总览", sub: "AI 编码任务中央调度台" },
  { match: (p) => p.startsWith("/tasks"), title: "任务调度", sub: "管理 AI 编码任务的发布、认领与执行进度" },
  { match: (p) => p.startsWith("/chat"), title: "实时对话", sub: "与 Worker 直连的低延迟对话流" },
  { match: (p) => p.startsWith("/workers"), title: "执行机群", sub: "Worker 节点的心跳、容量与在途任务" },
  { match: (p) => p.startsWith("/projects"), title: "代码项目", sub: "代码仓库与子仓的配置中心" },
  { match: (p) => p.startsWith("/users"), title: "用户权限", sub: "用户、角色与项目权限管理" }
];

function pageMetaFor(pathname: string): { title: string; sub: string } {
  for (const entry of PAGE_META) {
    if (entry.match(pathname)) return { title: entry.title, sub: entry.sub };
  }
  return { title: "ClaudeCenter", sub: "" };
}

// 全站外壳：侧边栏 + 主内容区。系统级 header 钉在主内容区顶部，左侧承担页面标题/描述，
// 右侧承担通知 + 当前用户信息（含登出）。各页面不再渲染 page-head。
export default function Shell({ currentUser, children }: { currentUser: CurrentUser; children: ReactNode }) {
  const canManageUsers = currentUser.permissions.includes("user.manage");
  const pathname = usePathname();
  const meta = pageMetaFor(pathname);

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
      </aside>

      <main className="main">
        <header className="app-header">
          <div className="app-header-titles">
            <h1 className="app-header-title">{meta.title}</h1>
            {meta.sub ? <span className="app-header-sub">{meta.sub}</span> : null}
          </div>
          <div className="app-header-actions">
            <Notifications />
            <div className="user-chip" tabIndex={0}>
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
        </header>
        <div className="view">{children}</div>
      </main>
    </div>
  );
}
