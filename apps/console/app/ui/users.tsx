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
  RefreshCw, ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select, useConfirm } from "./controls";
import { Donut } from "./overview-widgets";


type EditableUser = UserWithProjects;

// 角色 → Tone：侧栏「角色分布」环形与任务页状态环同源（.dot[data-tone] / TONE_COLOR）。
const ROLE_TONE: Record<Role, Tone> = {
  admin: "running",
  publisher: "success",
  commenter: "waiting",
  viewer: "draft"
};

// 工具栏角色筛选项：「全部角色」+ 四个角色，与任务页状态筛选同款 Select。
const ROLE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部角色" },
  ...ROLE_OPTIONS.map((role) => ({ value: role, label: ROLE_LABEL[role] }))
];

function UsersView({ projects, currentUser }: { projects: Project[]; currentUser: CurrentUser }) {
  const [users, setUsers] = useState<EditableUser[]>([]);
  const [editing, setEditing] = useState<EditableUser | null>(null);
  const [creating, setCreating] = useState(false);
  // 操作反馈改为底部悬浮 toast（与任务页 bulk-toast 一致），不再挤占头部文案位。
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [busy, setBusy] = useState(false);
  // 工具栏筛选：关键词（用户名/显示名）、角色、项目。用户全量加载，筛选纯前端不另发请求。
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const { confirm, dialog } = useConfirm();

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
      setToast({ text: error instanceof Error ? error.message : "加载失败", tone: "warn" });
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  // 操作反馈 toast 5 秒自动消失。
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  // 工具栏筛选结果。项目筛选下 admin 视为可访问全部项目，故选了项目时 admin 始终命中。
  const filteredUsers = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return users.filter((user) => {
      if (roleFilter && user.role !== roleFilter) return false;
      if (projectFilter && user.role !== "admin" && !user.project_ids.includes(projectFilter)) return false;
      if (kw) {
        const haystack = `${user.username} ${user.display_name ?? ""}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });
  }, [users, q, roleFilter, projectFilter]);

  const hasFilter = Boolean(q.trim() || roleFilter || projectFilter);

  async function handleDelete(user: EditableUser) {
    const ok = await confirm({
      title: "删除用户",
      message: `确认删除用户「${user.username}」？`,
      confirmText: "删除用户",
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/users/${user.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `删除失败：${response.status}`);
      }
      await loadUsers();
      setToast({ text: `已删除 ${user.username}`, tone: "ok" });
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : "删除失败", tone: "warn" });
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
      setToast({ text: `${user.username} 已${user.disabled ? "启用" : "停用"}`, tone: "ok" });
    } catch (error) {
      setToast({ text: error instanceof Error ? error.message : "操作失败", tone: "warn" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-grid">
        <main className="page-grid-main">
          <section className="card">
            <div className="toolbar">
              <div className="tb-search">
                <Search size={15} className="ico" />
                <input
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  placeholder="搜索用户名或显示名"
                />
              </div>
              <Select
                className="tb-select"
                value={roleFilter}
                onChange={setRoleFilter}
                options={ROLE_FILTERS}
                ariaLabel="按角色筛选"
              />
              <Select
                className="tb-select"
                value={projectFilter}
                onChange={setProjectFilter}
                options={[
                  { value: "", label: "全部项目" },
                  ...projects.map((project) => ({ value: project.id, label: project.name }))
                ]}
                ariaLabel="按项目筛选"
              />
              <div className="tb-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void loadUsers()}
                  title="刷新"
                >
                  <RefreshCw size={16} />
                  刷新
                </button>
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
            </div>

            <div className="card-body flush">
              {filteredUsers.length === 0 ? (
                <Empty
                  icon={<Users size={28} />}
                  text={hasFilter ? "没有符合条件的用户" : "暂无用户"}
                />
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
                      {filteredUsers.map((user) => (
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
                                {user.disabled ? (
                                  <span className="badge" data-tone="cancelled">已停用</span>
                                ) : null}
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
        </main>

        <aside className="page-grid-aside">
          <UsersSidebar users={users} projects={projects} />
        </aside>
      </div>

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
            projects={projects}
            onDone={async (note) => {
              setCreating(false);
              setToast({ text: note, tone: "ok" });
              await loadUsers();
            }}
          />
        ) : editing ? (
          <UserForm
            mode="edit"
            key={editing.id}
            user={editing}
            projects={projects}
            onDone={async (note) => {
              setEditing(null);
              setToast({ text: note, tone: "ok" });
              await loadUsers();
            }}
          />
        ) : null}
      </Drawer>

      {toast ? (
        <div className="bulk-toast" data-tone={toast.tone} role="status">
          <Check size={14} />
          <span>{toast.text}</span>
          <button
            type="button"
            className="bulk-toast-close"
            onClick={() => setToast(null)}
            aria-label="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ) : null}

      {dialog}
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
            <div className="dep-picker">
              <div className="dep-picker-list">
                {projects.map((project) => {
                  const checked = projectIds.includes(project.id);
                  return (
                    <button
                      type="button"
                      key={project.id}
                      className={`dep-option${checked ? " selected" : ""}`}
                      onClick={() => toggleProject(project.id)}
                      aria-pressed={checked}
                    >
                      <span className={`dep-check${checked ? " on" : ""}`} aria-hidden>
                        {checked ? <Check size={11} strokeWidth={3} /> : null}
                      </span>
                      <span className="dep-option-title">{project.name}</span>
                    </button>
                  );
                })}
              </div>
              {projectIds.length > 0 ? <span className="field-hint">已选 {projectIds.length} 个项目</span> : null}
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


// 用户权限页右侧栏：角色分布（环形）/ 项目覆盖（横条）/ 账户概览（三列）。
// 统计基于全量 users（不随工具栏筛选变动），口径与任务页右栏一致。
function UsersSidebar({ users, projects }: { users: EditableUser[]; projects: Project[] }) {
  const total = users.length;

  // 角色分布：按 ROLE_OPTIONS 顺序、过滤 0 计数；tone 取 ROLE_TONE。
  const roleSegments = ROLE_OPTIONS
    .map((role) => ({ role, n: users.filter((user) => user.role === role).length }))
    .filter((row) => row.n > 0)
    .map((row) => ({
      status: row.role,
      label: ROLE_LABEL[row.role],
      tone: ROLE_TONE[row.role],
      value: row.n
    }));

  // 项目覆盖：每个项目显式分配的非 admin 用户数（admin 全项目可见，不计入单项目），按数量降序。
  const coverage = projects
    .map((project) => ({
      id: project.id,
      name: project.name,
      n: users.filter((user) => user.role !== "admin" && user.project_ids.includes(project.id)).length
    }))
    .sort((a, b) => b.n - a.n);
  const maxCoverage = coverage.reduce((max, row) => Math.max(max, row.n), 0);

  const activeCount = users.filter((user) => !user.disabled).length;
  const disabledCount = total - activeCount;

  return (
    <>
      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><ShieldCheck size={15} /></span>
          <h3 className="section-title">角色分布</h3>
        </div>
        <div className="section-body">
          {total === 0 ? (
            <Empty icon={<Users size={22} />} text="暂无用户" />
          ) : (
            <Donut segments={roleSegments} total={total} centerLabel="用户" />
          )}
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><FolderGit2 size={15} /></span>
          <h3 className="section-title">项目覆盖</h3>
        </div>
        <div className="section-body">
          {coverage.length === 0 ? (
            <Empty icon={<FolderGit2 size={22} />} text="暂无项目" />
          ) : (
            <div className="sb-bars">
              {coverage.map((row) => (
                <div className="sb-bar-row" key={row.id}>
                  <span className="sb-bar-label" title={row.name}>{row.name}</span>
                  <span className="sb-bar-track">
                    <span
                      className="sb-bar-fill"
                      data-tone="running"
                      style={{ width: `${maxCoverage > 0 ? (row.n / maxCoverage) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="sb-bar-n">{row.n}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><Activity size={15} /></span>
          <h3 className="section-title">账户概览</h3>
        </div>
        <div className="section-body">
          <div className="sb-stat-cols">
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">用户总数</span>
              <span className="sb-stat-col-value">{total}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">启用中</span>
              <span className="sb-stat-col-value">{activeCount}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">已停用</span>
              <span className="sb-stat-col-value">{disabledCount}</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export { UsersView };
