"use client";

import {
  Boxes, ExternalLink, FolderGit2, LayoutGrid, ListTodo, LogOut, Menu, MessageSquare, Server, UserRound, Users, X
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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

// 顶栏 brand 区版本号。CI build 注入 NEXT_PUBLIC_APP_VERSION（如 0.2.0），本地为空时回退 dev。
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
// GitHub release 页：发布版按 cc-vX.Y.Z tag 直达对应发布说明，dev 退回 releases 列表页。
const RELEASES_BASE = "https://github.com/zzusp/claude-center/releases";
const RELEASE_URL =
  APP_VERSION === "dev" ? RELEASES_BASE : `${RELEASES_BASE}/tag/cc-v${APP_VERSION}`;

// 全站外壳：侧边栏 + 主内容区。系统级 header 钉在主内容区顶部，左侧承担页面标题/描述，
// 右侧承担通知 + 当前用户信息（含登出）。各页面不再渲染 page-head。
export default function Shell({ currentUser, children }: { currentUser: CurrentUser; children: ReactNode }) {
  const canManageUsers = currentUser.permissions.includes("user.manage");
  const pathname = usePathname();
  const meta = pageMetaFor(pathname);
  // 移动端导航抽屉开关：路由切换后自动关闭（点导航项即跳转 → 关抽屉）。
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

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
      {/* 移动端抽屉遮罩：点击关闭导航抽屉（仅 ≤820 渲染可见，桌面 display:none）。 */}
      <div
        className={`sidebar-backdrop${navOpen ? " open" : ""}`}
        onClick={() => setNavOpen(false)}
        aria-hidden
      />
      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">
            <Boxes size={18} />
          </span>
          <span className="brand-stack">
            <span className="brand-text">ClaudeCenter</span>
            <a
              className="brand-version"
              href={RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              title={`查看 v${APP_VERSION} 版本发布说明`}
            >
              v{APP_VERSION}
              <ExternalLink size={10} strokeWidth={2} />
            </a>
          </span>
          {/* 抽屉内关闭按钮：仅移动端显示。 */}
          <button
            type="button"
            className="nav-close"
            onClick={() => setNavOpen(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="nav">
          {navItems.map((item) => {
            // 高亮规则：严格匹配「/」=总览；其他菜单项以前缀匹配（覆盖 /chat/[projectId] 等子路由）。
            const active =
              item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${active ? " active" : ""}`}
              >
                <span className="nav-ico">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <header className="app-header">
          {/* 移动端汉堡：打开导航抽屉（桌面 display:none）。 */}
          <button
            type="button"
            className="nav-toggle"
            onClick={() => setNavOpen(true)}
            aria-label="打开导航"
            aria-expanded={navOpen}
          >
            <Menu size={20} />
          </button>
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
