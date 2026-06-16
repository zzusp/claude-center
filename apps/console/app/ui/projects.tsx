"use client";

import type { Project, ProjectRepo } from "@claude-center/db";
import { FolderGit2, GitBranch, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
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
    <>
      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label className="field-label">项目名</label>
          <input name="name" defaultValue={project?.name ?? ""} placeholder="claude-center" required />
        </div>
        <div className="field">
          <label className="field-label">Git 仓库地址（主仓）</label>
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
      {mode === "edit" && project ? <ProjectSubReposEditor projectId={project.id} /> : null}
    </>
  );
}

// 项目子仓清单编辑（多仓任务，spec docs/spec/task-multi-repo.md）：
// - 主仓由 projects 表镜像维护（不在此处管理）
// - 子仓列表 fetch /api/projects/[id]/repos，过滤 role='sub' 后展示并允许增删改
// - 保存按钮 PUT /api/projects/[id]/repos 整批替换；删除有任务引用的子仓后端返回 409
// 子仓在主仓本地路径下的 relative_path **必须** 被主仓 .gitignore 忽略；UI 加一行提示
function ProjectSubReposEditor({ projectId }: { projectId: string }) {
  const [subs, setSubs] = useState<Array<{ id?: string; relativePath: string; repoUrl: string; defaultBranch: string; displayName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/projects/${projectId}/repos`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { repos: ProjectRepo[] };
        if (!active) return;
        setSubs(
          data.repos
            .filter((r) => r.role === "sub")
            .map((r) => ({
              id: r.id,
              relativePath: r.relative_path,
              repoUrl: r.repo_url,
              defaultBranch: r.default_branch,
              displayName: r.display_name
            }))
        );
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError("拉取子仓清单失败");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  function add() {
    setSubs([...subs, { relativePath: "", repoUrl: "", defaultBranch: "main", displayName: "" }]);
  }
  function removeAt(idx: number) {
    setSubs(subs.filter((_, i) => i !== idx));
  }
  function patchAt(idx: number, p: Partial<(typeof subs)[number]>) {
    setSubs(subs.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/repos`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subs: subs.map((s, i) => ({
            relativePath: s.relativePath.trim(),
            repoUrl: s.repoUrl.trim(),
            defaultBranch: s.defaultBranch.trim() || "main",
            displayName: s.displayName.trim() || s.relativePath.trim(),
            position: i + 1
          }))
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败：${response.status}`);
      }
      const data = (await response.json()) as { repos: ProjectRepo[] };
      setSubs(
        data.repos
          .filter((r) => r.role === "sub")
          .map((r) => ({
            id: r.id,
            relativePath: r.relative_path,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            displayName: r.display_name
          }))
      );
      setNote("已保存子仓清单");
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="t-meta" style={{ marginTop: 16 }}>正在加载子仓清单…</div>;
  }

  return (
    <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <div className="section-head">
        <div>
          <h3 className="section-title" style={{ fontSize: "1em" }}>子仓清单（多仓任务）</h3>
          <span className="section-sub">
            子仓物理上位于主仓本地路径下；relative_path 必须已被主仓 <code>.gitignore</code> 忽略
          </span>
        </div>
        <button type="button" className="btn btn-sm" onClick={add} disabled={busy}>
          <Plus size={14} />
          新增子仓
        </button>
      </div>
      {subs.length === 0 ? (
        <div className="t-meta">暂无子仓（项目仅含主仓）</div>
      ) : (
        <div>
          {subs.map((s, idx) => (
            <div key={s.id ?? `new-${idx}`} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginBottom: 8 }}>
              <div className="form-row">
                <div className="field">
                  <label className="field-label">相对主仓路径</label>
                  <input value={s.relativePath} onChange={(e) => patchAt(idx, { relativePath: e.target.value })} placeholder="packages/widgets-lib" disabled={busy} />
                </div>
                <div className="field">
                  <label className="field-label">显示名（可选）</label>
                  <input value={s.displayName} onChange={(e) => patchAt(idx, { displayName: e.target.value })} placeholder={s.relativePath || "widgets"} disabled={busy} />
                </div>
              </div>
              <div className="form-row">
                <div className="field">
                  <label className="field-label">仓库地址</label>
                  <input value={s.repoUrl} onChange={(e) => patchAt(idx, { repoUrl: e.target.value })} placeholder="https://github.com/acme/sub.git" disabled={busy} />
                </div>
                <div className="field">
                  <label className="field-label">默认分支</label>
                  <input value={s.defaultBranch} onChange={(e) => patchAt(idx, { defaultBranch: e.target.value })} placeholder="main" disabled={busy} />
                </div>
              </div>
              <div className="row-actions">
                <button type="button" className="icon-btn danger" title="删除" onClick={() => removeAt(idx)} disabled={busy}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {error ? <div className="error-box" style={{ marginTop: 8 }}>{error}</div> : null}
      {note ? <div className="t-meta" style={{ marginTop: 8 }}>{note}</div> : null}
      <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={busy} style={{ marginTop: 8 }}>
        <Save size={14} />
        保存子仓清单
      </button>
    </div>
  );
}


export { ProjectsView };
