"use client";

import type { Project, ProjectRepo } from "@claude-center/db";
import {
  Boxes, ChevronRight, Clock, FolderGit2, GitBranch, ListTodo, Pencil, Plus, RefreshCw, Save, Search, Trash2
} from "lucide-react";
import { Fragment, FormEvent, useEffect, useMemo, useState } from "react";
import { basenameFromRepoUrl, Empty, fmtTime } from "./shared";
import { FormModal, useConfirm } from "./controls";

// 列表项：Project + 该项目的子仓清单（由 /api/projects 一次聚合）。
export type ProjectListItem = Project & { subRepos: ProjectRepo[] };

// 弹窗目标：编辑项目本身（不含子仓） / 管理子仓清单（增删改）。
// "新建项目"用独立 creating 状态，不入 modal 状态——因为新建时没有 project 上下文。
type ModalTarget =
  | { mode: "edit"; project: ProjectListItem }
  | { mode: "subs"; project: ProjectListItem; addNew: boolean };

// 侧栏「子仓分布」饼图配色：与任务页 PROJECT_PIE_COLORS 同色板循环。
const PROJECT_PIE_COLORS = [
  "var(--running)",
  "var(--success)",
  "var(--merged)",
  "var(--waiting)",
  "var(--scheduled)",
  "var(--draft)",
  "var(--review)",
  "var(--pending)",
  "var(--rejected)",
  "var(--cancelled)"
];

// 极坐标→笛卡尔。0° 在 12 点钟方向、顺时针递增。
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function ProjectsView({
  projects,
  onChanged,
  canManageProjects
}: {
  projects: ProjectListItem[];
  onChanged: () => void | Promise<void>;
  canManageProjects: boolean;
}) {
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const { confirm, dialog } = useConfirm();

  // 关键词 debounce（与任务页保持一致 300ms 节奏）
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onChanged();
    } finally {
      setRefreshing(false);
    }
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

  // 客户端筛选：项目名 / 描述 / 主仓 URL / 子仓名 / 子仓 URL，命中任一即保留。
  // 项目规模通常很小（量级 < 100），不引入分页/服务端筛选。
  const filtered = useMemo(() => {
    if (!debouncedQ) return projects;
    return projects.filter((p) => {
      if (p.name.toLowerCase().includes(debouncedQ)) return true;
      if ((p.description ?? "").toLowerCase().includes(debouncedQ)) return true;
      if ((p.repo_url ?? "").toLowerCase().includes(debouncedQ)) return true;
      return p.subRepos.some(
        (s) => s.name.toLowerCase().includes(debouncedQ) || s.repo_url.toLowerCase().includes(debouncedQ)
      );
    });
  }, [projects, debouncedQ]);

  const hasFilter = Boolean(debouncedQ);
  const modalOpen = creating || modal !== null;
  const modalTitle = creating
    ? "新建项目"
    : modal?.mode === "edit"
      ? `编辑 ${modal.project.name}`
      : modal?.mode === "subs"
        ? `管理子仓 · ${modal.project.name}`
        : "";
  // 子仓管理表单字段更多，弹窗用更宽的 lg 变体（720px）；项目编辑表单较短走 md（560px）。
  const modalSize: "md" | "lg" = modal?.mode === "subs" ? "lg" : "md";

  function closeModal() {
    setCreating(false);
    setModal(null);
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-head-title">代码项目</h1>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void handleRefresh()}
            title="刷新"
            disabled={refreshing}
          >
            <RefreshCw size={16} />
            刷新
          </button>
          {canManageProjects ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                setCreating(true);
                setModal(null);
              }}
            >
              <Plus size={16} />
              新建项目
            </button>
          ) : null}
        </div>
      </div>

      <div className="page-grid">
        <main className="page-grid-main">
          <section className="card">
            <div className="toolbar">
              <div className="tb-search">
                <Search size={15} className="ico" />
                <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索项目名 / 描述 / 仓库地址" />
              </div>
              {message ? <span className="t-meta">{message}</span> : null}
            </div>

            <div className="card-body flush">
              {filtered.length === 0 ? (
                <Empty
                  icon={<FolderGit2 size={28} />}
                  text={
                    hasFilter
                      ? "没有符合条件的项目"
                      : canManageProjects
                        ? "暂无项目，点击右上角新建项目"
                        : "暂无可访问的项目"
                  }
                />
              ) : (
                <div className="table-wrap">
                  <table className="table table-static">
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
                      {filtered.map((project) => {
                        const subCount = project.subRepos.length;
                        const isOpen = expanded.has(project.id);
                        const colSpan = canManageProjects ? 6 : 5;
                        return (
                          <Fragment key={project.id}>
                            <tr>
                              <td>
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
                                  <div className="row-actions">
                                    <button
                                      type="button"
                                      className="icon-btn"
                                      title="管理子仓"
                                      onClick={() => {
                                        setModal({ mode: "subs", project, addNew: subCount === 0 });
                                        setCreating(false);
                                      }}
                                    >
                                      <Boxes size={14} />
                                    </button>
                                    <button
                                      type="button"
                                      className="icon-btn"
                                      title="编辑"
                                      onClick={() => {
                                        setModal({ mode: "edit", project });
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
                                      onClick={() => void handleDelete(project)}
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
        </main>

        <aside className="page-grid-aside">
          <ProjectsSidebar projects={projects} />
        </aside>
      </div>

      <FormModal open={modalOpen} title={modalTitle} size={modalSize} onClose={closeModal}>
        {creating ? (
          <ProjectForm
            mode="create"
            onDone={async (note) => {
              setCreating(false);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : modal?.mode === "edit" ? (
          <ProjectForm
            mode="edit"
            key={modal.project.id}
            project={modal.project}
            onDone={async (note) => {
              setModal(null);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : modal?.mode === "subs" ? (
          <ProjectSubReposEditor
            key={`subs-${modal.project.id}`}
            projectId={modal.project.id}
            autoAddNew={modal.addNew}
            onSaved={async (note) => {
              setMessage(note);
              await onChanged();
            }}
          />
        ) : null}
      </FormModal>

      {dialog}
    </>
  );
}

// 项目侧栏：项目总览（计数卡）/ 子仓分布饼图 / 最近新增。
// 全部基于父组件已加载的 projects 列表本地聚合，无需新接口。
function ProjectsSidebar({ projects }: { projects: ProjectListItem[] }) {
  const total = projects.length;
  const withSubs = projects.filter((p) => p.subRepos.length > 0).length;
  const subTotal = projects.reduce((sum, p) => sum + p.subRepos.length, 0);

  // 子仓分布：仅展示有子仓的项目，按子仓数降序。
  const subDistribution = useMemo(
    () =>
      projects
        .map((p) => ({ id: p.id, name: p.name, n: p.subRepos.length }))
        .filter((row) => row.n > 0)
        .sort((a, b) => b.n - a.n),
    [projects]
  );

  // 最近新增：按 created_at 倒序取前 5。
  const recent = useMemo(() => {
    const sorted = [...projects].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return tb - ta;
    });
    return sorted.slice(0, 5);
  }, [projects]);

  return (
    <>
      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><FolderGit2 size={15} /></span>
          <h3 className="section-title">项目总览</h3>
        </div>
        <div className="section-body">
          <div className="sb-stat-cols">
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">项目总数</span>
              <span className="sb-stat-col-value">{total}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">含子仓项目</span>
              <span className="sb-stat-col-value">{withSubs}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">子仓总数</span>
              <span className="sb-stat-col-value">{subTotal}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><Boxes size={15} /></span>
          <h3 className="section-title">子仓分布</h3>
        </div>
        <div className="section-body">
          {subDistribution.length === 0 ? (
            <Empty icon={<Boxes size={22} />} text="暂无子仓" />
          ) : (
            <SubRepoPie data={subDistribution} total={subTotal} />
          )}
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><Clock size={15} /></span>
          <h3 className="section-title">最近新增</h3>
        </div>
        <div className="section-body">
          {recent.length === 0 ? (
            <Empty icon={<ListTodo size={22} />} text="暂无项目" />
          ) : (
            <div className="legend">
              {recent.map((p) => (
                <div className="legend-item" key={p.id}>
                  <span className="legend-label" title={p.name}>{p.name}</span>
                  <span className="legend-val">{fmtTime(p.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

// 子仓分布饼图：按项目分扇形 + 右侧 legend。单项目时退化为整圆。
// 实现与任务页 ProjectPie 同形（不依赖外部组件，独立内联保证两边演进解耦）。
function SubRepoPie({ data, total }: { data: { id: string; name: string; n: number }[]; total: number }) {
  const size = 128;
  const r = size / 2;
  const cx = r;
  const cy = r;
  const single = data.length === 1;
  let acc = 0;
  return (
    <div className="donut-wrap">
      <div className="pie-center" style={{ width: size, height: size }}>
        <svg className="pie" width={size} height={size}>
          {single ? (
            <circle cx={cx} cy={cy} r={r} fill={PROJECT_PIE_COLORS[0]} />
          ) : (
            data.map((row, i) => {
              const start = (acc / total) * 360;
              acc += row.n;
              const end = (acc / total) * 360;
              const [x1, y1] = polar(cx, cy, r, start);
              const [x2, y2] = polar(cx, cy, r, end);
              const large = end - start > 180 ? 1 : 0;
              const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
              return <path key={row.id} d={d} fill={PROJECT_PIE_COLORS[i % PROJECT_PIE_COLORS.length]} />;
            })
          )}
        </svg>
      </div>
      <div className="legend">
        {data.map((row, i) => (
          <div className="legend-item" key={row.id}>
            <span className="dot" style={{ background: PROJECT_PIE_COLORS[i % PROJECT_PIE_COLORS.length] }} />
            <span className="legend-label" title={row.name}>{row.name}</span>
            <span className="legend-val">{row.n}</span>
          </div>
        ))}
      </div>
    </div>
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
      {mode === "edit" ? (
        <div className="t-meta">子仓增删改请使用列表行的「管理子仓」入口。</div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {mode === "create" ? <Plus size={16} /> : <Save size={16} />}
        {mode === "create" ? "创建项目" : "保存修改"}
      </button>
    </form>
  );
}

// 项目子仓清单编辑（多仓任务，spec docs/spec/task-multi-repo.md、docs/spec/project-repos-runtime-path.md）：
// - 主仓由 projects 表镜像维护（不在此处管理）
// - 子仓列表 fetch /api/projects/[id]/repos，过滤 role='sub' 后展示并允许增删改
// - 子仓本机相对路径 / 文件夹名由 **worker 运行时派生**（不同 worker 上可能不同），console 端不维护
// - 保存按钮 PUT /api/projects/[id]/repos 整批替换；删除有任务引用的子仓后端返回 409
// autoAddNew：列表行"管理子仓"入口打开时，加载完已有子仓后自动追加一行空行供填写
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
    return <div className="t-meta">正在加载子仓清单…</div>;
  }

  return (
    <div>
      <div className="sub-editor-head">
        <div className="sub-editor-head-text">
          <h3 className="section-title">子仓清单（多仓任务）</h3>
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
            <div key={s.id ?? `new-${idx}`} className="sub-editor-item">
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
      <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={busy} style={{ marginTop: 12 }}>
        <Save size={14} />
        保存子仓清单
      </button>
    </div>
  );
}

// 列表行展开后的子仓只读视图：仅展示，不在此处编辑（编辑走「管理子仓」入口）。
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
