"use client";

import type { Project } from "@claude-center/db";
import { FolderGit2, GitBranch, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { Empty, fmtTime } from "./shared";
import { Drawer, useConfirm } from "./controls";


function ProjectsView({
  projects,
  onChanged,
  canManageProjects
}: {
  projects: Project[];
  onChanged: () => void | Promise<void>;
  canManageProjects: boolean;
}) {
  const [editing, setEditing] = useState<Project | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  async function handleDelete(project: Project) {
    const ok = await confirm({
      title: "删除项目",
      message: `确认删除项目「${project.name}」？其下所有任务记录将一并级联删除，且不可恢复。`,
      confirmText: "删除项目",
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `删除失败：${response.status}`);
      }
      const data = (await response.json()) as { taskCount?: number };
      await onChanged();
      setMessage(`已删除项目 ${project.name}${data.taskCount ? `（含 ${data.taskCount} 个任务）` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">代码项目</h2>
          <span className="section-sub">
            {projects.length} 个项目{message ? ` · ${message}` : ""}
          </span>
        </div>
        {canManageProjects ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setCreating(true);
              setEditing(null);
            }}
          >
            <Plus size={16} />
            新建项目
          </button>
        ) : null}
      </div>

      <section className="card">
        <div className="card-body flush">
          {projects.length === 0 ? (
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
                    {canManageProjects ? <th className="t-right">操作</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => (
                    <tr
                      key={project.id}
                      className={editing?.id === project.id ? "selected" : ""}
                      style={canManageProjects ? undefined : { cursor: "default" }}
                      onClick={
                        canManageProjects
                          ? () => {
                              setEditing(project);
                              setCreating(false);
                            }
                          : undefined
                      }
                    >
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
                      {canManageProjects ? (
                        <td className="t-right">
                          <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                            <button
                              type="button"
                              className="icon-btn"
                              title="编辑"
                              onClick={() => {
                                setEditing(project);
                                setCreating(false);
                              }}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn danger"
                              title="删除"
                              disabled={busy}
                              onClick={() => handleDelete(project)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      ) : null}
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
        title={creating ? "新建项目" : editing ? `编辑 ${editing.name}` : ""}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      >
        {creating ? (
          <ProjectForm
            mode="create"
            onDone={async (note) => {
              setCreating(false);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : editing ? (
          <ProjectForm
            mode="edit"
            key={editing.id}
            project={editing}
            onDone={async (note) => {
              setEditing(null);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : null}
      </Drawer>

      {dialog}
    </>
  );
}

function ProjectForm({
  mode,
  project,
  onDone
}: {
  mode: "create" | "edit";
  project?: Project;
  onDone: (note: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      name: String(data.get("name") ?? "").trim(),
      repoUrl: String(data.get("repoUrl") ?? "").trim(),
      defaultBranch: String(data.get("defaultBranch") ?? "").trim(),
      description: String(data.get("description") ?? "").trim()
    };
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        const response = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `创建失败：${response.status}`);
        }
        await onDone(`已创建项目 ${body.name}`);
      } else if (project) {
        const response = await fetch(`/api/projects/${project.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `保存失败：${response.status}`);
        }
        await onDone(`已更新项目 ${body.name}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field-label">项目名</label>
        <input name="name" defaultValue={project?.name ?? ""} placeholder="claude-center" required />
      </div>
      <div className="field">
        <label className="field-label">Git 仓库地址</label>
        <input name="repoUrl" defaultValue={project?.repo_url ?? ""} placeholder="https://github.com/acme/repo.git" required />
      </div>
      <div className="field">
        <label className="field-label">默认分支</label>
        <input name="defaultBranch" defaultValue={project?.default_branch ?? "main"} placeholder="main" />
      </div>
      <div className="field">
        <label className="field-label">描述</label>
        <textarea name="description" defaultValue={project?.description ?? ""} rows={3} placeholder="项目说明" />
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {mode === "create" ? <Plus size={16} /> : <Save size={16} />}
        {mode === "create" ? "创建项目" : "保存修改"}
      </button>
    </form>
  );
}


export { ProjectsView };
