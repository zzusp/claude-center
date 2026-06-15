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


type EditableUser = UserWithProjects;

function UsersView({ projects, currentUser }: { projects: Project[]; currentUser: CurrentUser }) {
  const [users, setUsers] = useState<EditableUser[]>([]);
  const [editing, setEditing] = useState<EditableUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
      setMessage(error instanceof Error ? error.message : "加载失败");
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

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
            projects={projects}
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
            projects={projects}
            onDone={async (note) => {
              setEditing(null);
              setMessage(note);
              await loadUsers();
            }}
          />
        ) : null}
      </Drawer>

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


export { UsersView };
