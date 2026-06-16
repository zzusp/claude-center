"use client";

import type { Project, ProjectRepo } from "@claude-center/db";
import { ChevronRight, FolderGit2, GitBranch, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { Fragment, FormEvent, useEffect, useState } from "react";
import { basenameFromRepoUrl, Empty, fmtTime } from "./shared";
import { Drawer, useConfirm } from "./controls";

// 列表项：Project + 该项目的子仓清单（由 /api/projects 一次聚合）。
export type ProjectListItem = Project & { subRepos: ProjectRepo[] };

// 抽屉打开模式：编辑项目本身（含子仓编辑器） / 仅管理子仓（聚焦"添加子仓"）。
type DrawerTarget =
  | { mode: "edit"; project: ProjectListItem }
  | { mode: "subs"; project: ProjectListItem; addNew: boolean };

function ProjectsView({
  projects,
  onChanged,
  canManageProjects
}: {
  projects: ProjectListItem[];
  onChanged: () => void | Promise<void>;
  canManageProjects: boolean;
}) {
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleDelete(project: ProjectListItem) {
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
              setDrawer(null);
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
                    <th style={{ width: 28 }} aria-label="展开" />
                    <th>项目</th>
                    <th>仓库</th>
                    <th>默认分支</th>
                    <th className="t-right">创建于</th>
                    {canManageProjects ? <th className="t-right">操作</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project) => {
                    const subCount = project.subRepos.length;
                    const isOpen = expanded.has(project.id);
                    const colSpan = canManageProjects ? 6 : 5;
                    return (
                      <Fragment key={project.id}>
                        <tr
                          className={drawer?.project.id === project.id ? "selected" : ""}
                          style={canManageProjects ? undefined : { cursor: "default" }}
                          onClick={
                            canManageProjects
                              ? () => {
                                  setDrawer({ mode: "edit", project });
                                  setCreating(false);
                                }
                              : undefined
                          }
                        >
                          <td onClick={(event) => event.stopPropagation()}>
                            {subCount > 0 ? (
                              <button
                                type="button"
                                className="icon-btn"
                                title={isOpen ? "折叠子仓" : `展开 ${subCount} 个子仓`}
                                aria-expanded={isOpen}
                                onClick={() => toggleExpanded(project.id)}
                              >
                                <ChevronRight
                                  size={14}
                                  className="tx-caret"
                                  style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
                                />
                              </button>
                            ) : null}
                          </td>
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
                                  title="添加子仓"
                                  onClick={() => {
                                    setDrawer({ mode: "subs", project, addNew: true });
                                    setCreating(false);
                                    if (subCount > 0 && !isOpen) toggleExpanded(project.id);
                                  }}
                                >
                                  <Plus size={14} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-btn"
                                  title="编辑"
                                  onClick={() => {
                                    setDrawer({ mode: "edit", project });
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
                        {isOpen && subCount > 0 ? (
                          <tr className="sub-row">
                            <td />
                            <td colSpan={colSpan - 1} style={{ padding: "8px 16px 12px" }}>
                              <SubReposInlineList subRepos={project.subRepos} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Drawer
        open={creating || drawer !== null}
        title={
          creating
            ? "新建项目"
            : drawer?.mode === "edit"
              ? `编辑 ${drawer.project.name}`
              : drawer?.mode === "subs"
                ? `管理子仓 · ${drawer.project.name}`
                : ""
        }
        onClose={() => {
          setCreating(false);
          setDrawer(null);
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
        ) : drawer?.mode === "edit" ? (
          <ProjectForm
            mode="edit"
            key={drawer.project.id}
            project={drawer.project}
            onDone={async (note) => {
              setDrawer(null);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : drawer?.mode === "subs" ? (
          <ProjectSubReposEditor
            key={`subs-${drawer.project.id}`}
            projectId={drawer.project.id}
            autoAddNew={drawer.addNew}
            onSaved={async (note) => {
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
  project?: ProjectListItem;
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

// 项目子仓清单编辑（多仓任务，spec docs/spec/task-multi-repo.md、docs/spec/project-repos-runtime-path.md）：
// - 主仓由 projects 表镜像维护（不在此处管理）
// - 子仓列表 fetch /api/projects/[id]/repos，过滤 role='sub' 后展示并允许增删改
// - 子仓本机相对路径 / 文件夹名由 **worker 运行时派生**（不同 worker 上可能不同），console 端不维护
// - 保存按钮 PUT /api/projects/[id]/repos 整批替换；删除有任务引用的子仓后端返回 409
// autoAddNew：列表行"+ 子仓"快捷入口打开抽屉时，加载完已有子仓后自动追加一行空行供填写
// onSaved：保存成功回调，通知父组件触发列表重拉
function ProjectSubReposEditor({
  projectId,
  autoAddNew = false,
  onSaved
}: {
  projectId: string;
  autoAddNew?: boolean;
  onSaved?: (note: string) => void | Promise<void>;
}) {
  const [subs, setSubs] = useState<Array<{ id?: string; name: string; repoUrl: string; defaultBranch: string; description: string }>>([]);
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
        const existing = data.repos
          .filter((r) => r.role === "sub")
          .map((r) => ({
            id: r.id,
            name: r.name,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            description: r.description
          }));
        setSubs(
          autoAddNew
            ? [...existing, { name: "", repoUrl: "", defaultBranch: "main", description: "" }]
            : existing
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
  }, [projectId, autoAddNew]);

  function add() {
    setSubs([...subs, { name: "", repoUrl: "", defaultBranch: "main", description: "" }]);
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
            name: s.name.trim(),
            repoUrl: s.repoUrl.trim(),
            defaultBranch: s.defaultBranch.trim() || "main",
            description: s.description.trim(),
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
            name: r.name,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            description: r.description
          }))
      );
      setNote("已保存子仓清单");
      await onSaved?.("已保存子仓清单");
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
            子仓物理上位于主仓本地路径下；本机文件夹名由 worker 运行时派生（不同 worker 可不一致）
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
                  <label className="field-label">项目名</label>
                  <input value={s.name} onChange={(e) => patchAt(idx, { name: e.target.value })} placeholder="widgets-lib" disabled={busy} />
                </div>
                <div className="field">
                  <label className="field-label">默认分支</label>
                  <input value={s.defaultBranch} onChange={(e) => patchAt(idx, { defaultBranch: e.target.value })} placeholder="main" disabled={busy} />
                </div>
              </div>
              <div className="field">
                <label className="field-label">Git 仓库地址</label>
                <input value={s.repoUrl} onChange={(e) => patchAt(idx, { repoUrl: e.target.value })} placeholder="https://github.com/acme/widgets-lib.git" disabled={busy} />
              </div>
              <div className="field">
                <label className="field-label">描述</label>
                <textarea value={s.description} onChange={(e) => patchAt(idx, { description: e.target.value })} rows={2} placeholder="子仓说明（可选）" disabled={busy} />
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

// 列表行展开后的子仓只读视图：仅展示，不在此处编辑（编辑走"+ 子仓"或"编辑"抽屉）。
function SubReposInlineList({ subRepos }: { subRepos: ProjectRepo[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span className="t-meta">子仓 {subRepos.length} 个</span>
      <table className="table" style={{ background: "var(--surface-1)" }}>
        <thead>
          <tr>
            <th>项目名</th>
            <th>仓库</th>
            <th>默认分支</th>
            <th>描述</th>
          </tr>
        </thead>
        <tbody>
          {subRepos.map((r) => (
            <tr key={r.id} style={{ cursor: "default" }}>
              <td><span className="t-title">{r.name || basenameFromRepoUrl(r.repo_url)}</span></td>
              <td className="mono">{r.repo_url}</td>
              <td>
                <span className="tag">
                  <GitBranch size={13} className="ico" />
                  {r.default_branch}
                </span>
              </td>
              <td className="t-meta">{r.description || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


export { ProjectsView };
