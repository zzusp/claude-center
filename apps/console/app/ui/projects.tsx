"use client";

import type { Project, ProjectRepo } from "@claude-center/db";
import {
  ArrowDown, ArrowUp, Boxes, ChevronRight, Clock, FolderGit2, GitBranch, ListTodo, Pencil, Plus, RefreshCw, Save, Search, Trash2
} from "lucide-react";
import { Fragment, FormEvent, useEffect, useMemo, useState } from "react";
import { basenameFromRepoUrl, Empty, fmtDateTime, fmtTime } from "./shared";
import { FormModal, useConfirm } from "./controls";

// 列表项：Project + 该项目的子仓清单（由 /api/projects 一次聚合）。
export type ProjectListItem = Project & { subRepos: ProjectRepo[] };

// 弹窗目标：
// - edit：编辑项目本身（不含子仓）
// - addSub：在该项目下新增一个子仓
// - editSub：编辑该项目下指定子仓
// "新建项目"用独立 creating 状态，不入 modal 状态——因为新建时没有 project 上下文。
type ModalTarget =
  | { mode: "edit"; project: ProjectListItem }
  | { mode: "addSub"; project: ProjectListItem }
  | { mode: "editSub"; project: ProjectListItem; sub: ProjectRepo };

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
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
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

  // 删除单个子仓：构造剔除该子仓后的完整清单 PUT。
  // 该子仓若仍有 task_repos 引用，后端返回 409，错误提示透出。
  async function handleDeleteSub(project: ProjectListItem, sub: ProjectRepo) {
    const ok = await confirm({
      title: "删除子仓",
      message: `确认从项目「${project.name}」中移除子仓「${sub.name || basenameFromRepoUrl(sub.repo_url)}」？若仍有任务引用该子仓将无法删除。`,
      confirmText: "删除子仓",
      danger: true
    });
    if (!ok) return;
    setBusy(true);
    try {
      const remaining = project.subRepos.filter((r) => r.id !== sub.id);
      const response = await fetch(`/api/projects/${project.id}/repos`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subs: remaining.map((r, i) => ({
            name: r.name,
            repoUrl: r.repo_url,
            defaultBranch: r.default_branch,
            description: r.description,
            position: i + 1
          }))
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `删除失败：${response.status}`);
      }
      await onChanged();
      setMessage(`已删除子仓 ${sub.name || basenameFromRepoUrl(sub.repo_url)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  // 客户端筛选：项目名 / 描述 / 主仓 URL / 子仓名 / 子仓 URL，命中任一即保留。
  // 项目规模通常很小（量级 < 100），不引入分页/服务端筛选。
  const filtered = useMemo(() => {
    const matched = !debouncedQ
      ? projects
      : projects.filter((p) => {
          if (p.name.toLowerCase().includes(debouncedQ)) return true;
          if ((p.description ?? "").toLowerCase().includes(debouncedQ)) return true;
          if ((p.repo_url ?? "").toLowerCase().includes(debouncedQ)) return true;
          return p.subRepos.some(
            (s) => s.name.toLowerCase().includes(debouncedQ) || s.repo_url.toLowerCase().includes(debouncedQ)
          );
        });
    return [...matched].sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return sortDir === "asc" ? ta - tb : tb - ta;
    });
  }, [projects, debouncedQ, sortDir]);

  const hasFilter = Boolean(debouncedQ);
  const modalOpen = creating || modal !== null;
  const modalTitle = creating
    ? "新建项目"
    : modal?.mode === "edit"
      ? `编辑 ${modal.project.name}`
      : modal?.mode === "addSub"
        ? `添加子仓 · ${modal.project.name}`
        : modal?.mode === "editSub"
          ? `编辑子仓 · ${modal.sub.name || basenameFromRepoUrl(modal.sub.repo_url)}`
          : "";

  function closeModal() {
    setCreating(false);
    setModal(null);
  }

  return (
    <>
      <div className="page-grid">
        <main className="page-grid-main">
          <section className="card">
            <div className="toolbar">
              <div className="tb-search">
                <Search size={15} className="ico" />
                <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索项目名 / 描述 / 仓库地址" />
              </div>
              {message ? <span className="t-meta">{message}</span> : null}
              <div className="tb-actions">
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

            <div className="card-body flush">
              {filtered.length === 0 ? (
                <Empty
                  icon={<FolderGit2 size={28} />}
                  text={
                    hasFilter
                      ? "没有符合条件的项目"
                      : canManageProjects
                        ? "暂无项目,点击右上角新建项目"
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
                        <th
                          className="t-right"
                          style={{ cursor: "pointer", userSelect: "none" }}
                          onClick={() => setSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                          title="点击切换创建时间排序"
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            创建于
                            {sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                          </span>
                        </th>
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
                              <td className="mono">
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <FolderGit2 size={14} className="ico" />
                                  {project.repo_url}
                                </span>
                              </td>
                              <td>
                                <span className="tag">
                                  <GitBranch size={13} className="ico" />
                                  {project.default_branch}
                                </span>
                              </td>
                              <td className="t-right t-num">{fmtDateTime(project.created_at)}</td>
                              {canManageProjects ? (
                                <td className="t-right">
                                  <div className="row-actions">
                                    <button
                                      type="button"
                                      className="icon-btn"
                                      title="添加子仓"
                                      onClick={() => {
                                        setModal({ mode: "addSub", project });
                                        setCreating(false);
                                        // 添加后自动展开,方便看到新行
                                        setExpanded((prev) => {
                                          const next = new Set(prev);
                                          next.add(project.id);
                                          return next;
                                        });
                                      }}
                                    >
                                      <Plus size={14} />
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
                                  <SubReposInlineList
                                    subRepos={project.subRepos}
                                    canManage={canManageProjects}
                                    busy={busy}
                                    onEdit={(sub) => {
                                      setModal({ mode: "editSub", project, sub });
                                      setCreating(false);
                                    }}
                                    onDelete={(sub) => void handleDeleteSub(project, sub)}
                                  />
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

      <FormModal open={modalOpen} title={modalTitle} size="md" onClose={closeModal}>
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
        ) : modal?.mode === "addSub" ? (
          <SubRepoForm
            key={`add-${modal.project.id}`}
            project={modal.project}
            onDone={async (note) => {
              setModal(null);
              setMessage(note);
              await onChanged();
            }}
          />
        ) : modal?.mode === "editSub" ? (
          <SubRepoForm
            key={`edit-${modal.sub.id}`}
            project={modal.project}
            sub={modal.sub}
            onDone={async (note) => {
              setModal(null);
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
// 全部基于父组件已加载的 projects 列表本地聚合,无需新接口。
function ProjectsSidebar({ projects }: { projects: ProjectListItem[] }) {
  const total = projects.length;
  const withSubs = projects.filter((p) => p.subRepos.length > 0).length;
  const subTotal = projects.reduce((sum, p) => sum + p.subRepos.length, 0);

  // 子仓分布：仅展示有子仓的项目,按子仓数降序。
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
// 实现与任务页 ProjectPie 同形(不依赖外部组件,独立内联保证两边演进解耦)。
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
        <label className="field-label">Git 仓库地址(主仓)</label>
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
        <div className="t-meta">子仓在列表行点击「添加子仓」逐条管理；编辑 / 删除在展开的子仓表格上直接操作。</div>
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {mode === "create" ? <Plus size={16} /> : <Save size={16} />}
        {mode === "create" ? "创建项目" : "保存修改"}
      </button>
    </form>
  );
}

// 单条子仓表单（多仓任务,spec docs/spec/task-multi-repo.md、docs/spec/project-repos-runtime-path.md）：
// - 新增：sub 不传,提交时把 [...该项目现有子仓, 表单一条] 整批 PUT
// - 编辑：sub 传入,提交时把 [...该项目现有子仓中除被编辑那条以外, 表单一条] 整批 PUT
// - 子仓本机相对路径 / 文件夹名由 **worker 运行时派生**(不同 worker 上可能不同),console 端不维护
// - PUT /api/projects/[id]/repos 整批替换；删除有任务引用的子仓后端返回 409(透出错误)
function SubRepoForm({
  project,
  sub,
  onDone
}: {
  project: ProjectListItem;
  sub?: ProjectRepo;
  onDone: (note: string) => void | Promise<void>;
}) {
  const isEdit = Boolean(sub);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const repoUrl = String(data.get("repoUrl") ?? "").trim();
    const defaultBranch = String(data.get("defaultBranch") ?? "").trim() || "main";
    const description = String(data.get("description") ?? "").trim();

    if (!repoUrl) {
      setError("Git 仓库地址必填");
      return;
    }
    if (repoUrl === project.repo_url) {
      setError("子仓 Git 地址不可与主仓相同");
      return;
    }
    // 同项目内不可重复(DB UNIQUE(project_id, repo_url);这里先做友好校验)。
    const conflict = project.subRepos.find((r) => r.repo_url === repoUrl && r.id !== sub?.id);
    if (conflict) {
      setError(`该 Git 地址已在子仓「${conflict.name || basenameFromRepoUrl(conflict.repo_url)}」中存在`);
      return;
    }

    const others = project.subRepos.filter((r) => r.id !== sub?.id);
    const merged = [
      ...others.map((r) => ({
        name: r.name,
        repoUrl: r.repo_url,
        defaultBranch: r.default_branch,
        description: r.description
      })),
      { name, repoUrl, defaultBranch, description }
    ];

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${project.id}/repos`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subs: merged.map((s, i) => ({ ...s, position: i + 1 }))
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败：${response.status}`);
      }
      await onDone(isEdit ? `已更新子仓 ${name || basenameFromRepoUrl(repoUrl)}` : `已添加子仓 ${name || basenameFromRepoUrl(repoUrl)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="t-meta">
        所属项目：<span className="t-title">{project.name}</span>
      </div>
      <div className="field">
        <label className="field-label">项目名</label>
        <input name="name" defaultValue={sub?.name ?? ""} placeholder="widgets-lib" />
      </div>
      <div className="field">
        <label className="field-label">Git 仓库地址</label>
        <input
          name="repoUrl"
          defaultValue={sub?.repo_url ?? ""}
          placeholder="https://github.com/acme/widgets-lib.git"
          required
        />
      </div>
      <div className="field">
        <label className="field-label">默认分支</label>
        <input name="defaultBranch" defaultValue={sub?.default_branch ?? "main"} placeholder="main" />
      </div>
      <div className="field">
        <label className="field-label">描述</label>
        <textarea name="description" defaultValue={sub?.description ?? ""} rows={3} placeholder="子仓说明(可选)" />
      </div>
      <div className="t-meta">
        本机文件夹名 / 路径由 worker 运行时派生(不同 worker 上可能不同),此处无需维护。
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {isEdit ? <Save size={16} /> : <Plus size={16} />}
        {isEdit ? "保存修改" : "添加子仓"}
      </button>
    </form>
  );
}

// 列表行展开后的子仓表格：每行可直接编辑 / 删除。
function SubReposInlineList({
  subRepos,
  canManage,
  busy,
  onEdit,
  onDelete
}: {
  subRepos: ProjectRepo[];
  canManage: boolean;
  busy: boolean;
  onEdit: (sub: ProjectRepo) => void;
  onDelete: (sub: ProjectRepo) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <table className="table" style={{ background: "var(--surface-1)" }}>
        <thead>
          <tr>
            <th>项目名</th>
            <th>仓库</th>
            <th>默认分支</th>
            <th>描述</th>
            {canManage ? <th className="t-right" style={{ width: 90 }}>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {subRepos.map((r) => (
            <tr key={r.id} style={{ cursor: "default" }}>
              <td><span className="t-title">{r.name || basenameFromRepoUrl(r.repo_url)}</span></td>
              <td className="mono">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <FolderGit2 size={14} className="ico" />
                  {r.repo_url}
                </span>
              </td>
              <td>
                <span className="tag">
                  <GitBranch size={13} className="ico" />
                  {r.default_branch}
                </span>
              </td>
              <td className="t-meta">{r.description || "—"}</td>
              {canManage ? (
                <td className="t-right">
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="编辑子仓"
                      onClick={() => onEdit(r)}
                      disabled={busy}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      title="删除子仓"
                      onClick={() => onDelete(r)}
                      disabled={busy}
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
  );
}


export { ProjectsView };
