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
  Clock, Cpu, Database, ExternalLink, Eye, FolderGit2, GitBranch, GitPullRequest, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RefreshCw, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, STATUS_META, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type ViewKey
} from "./dashboard-shared";
import { Donut } from "./overview-widgets";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { FormModal, Select, useConfirm } from "./controls";
import { TaskEditForm } from "./task-detail";
import { TaskComposeModal } from "./tasks-compose";


type ListResponse = { tasks: Task[]; total: number; page: number; pageSize: number; stats?: TaskStatsPayload };

type TaskStatsPayload = {
  total: number;
  byStatus: Record<string, number>;
  byProject: { id: string; name: string; n: number }[];
  today: { created: number; finished: number; accepted: number; rejected: number; avgDurationMs: number | null };
};

// 从 GitHub PR URL 抽 PR 号；非标准格式（含手填）返回 null，UI 退回 ExternalLink。
function parsePrNumber(url: string | null): number | null {
  if (!url) return null;
  const m = url.match(/\/pull\/(\d+)\b/);
  return m ? Number(m[1]) : null;
}

// 平均耗时人读：右栏「今日统计」用，单位毫秒 → 自适应秒/分/时。
function fmtDurationMs(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小时` : `${h}h ${rest}m`;
}

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "scheduled", label: "定时待发" },
  { value: "pending", label: "待处理" },
  { value: "claimed", label: "已认领" },
  { value: "running", label: "执行中" },
  { value: "waiting", label: "等待回复" },
  { value: "success", label: "已完成" },
  { value: "merged", label: "已合并" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" }
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

// 右侧栏「状态分布」按钩子顺序排序（与 STATUS_FILTERS 对齐），未出现的状态隐藏。
const STATUS_ORDER: string[] = [
  "draft", "scheduled", "pending", "claimed", "running", "waiting",
  "success", "merged", "accepted", "rejected", "failed", "cancelled"
];

function TasksView({
  projects,
  onOpenTask,
  onOpenCompose,
  canCreateTask
}: {
  projects: Project[];
  onOpenTask: (task: Task) => void;
  onOpenCompose: () => void;
  canCreateTask: boolean;
}) {
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  // Worker 维度过滤：取已认领任务的 worker_id；不限即空字符串。
  const [workerId, setWorkerId] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // 列表固定按更新时间排序，方向由「更新」表头切换（默认降序）。
  const [dir, setDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse>({ tasks: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  // 列表内编辑/删除：编辑套用详情页同款 TaskEditForm（抽屉），删除走非原生确认弹框。
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // 右侧栏 worker 下拉与统计：上层共享下拉数据源。
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [sidebarStats, setSidebarStats] = useState<TaskStatsPayload | null>(null);
  const { confirm, dialog } = useConfirm();

  async function handleDelete(task: Task) {
    const ok = await confirm({
      title: "删除任务",
      message: `确认删除任务「${task.title}」？此操作不可撤销。`,
      confirmText: "删除任务",
      danger: true
    });
    if (!ok) return;
    const response = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    if (response.ok) setRefreshKey((prev) => prev + 1);
  }

  // 待处理任务退回草稿：撤回尚未被认领的任务（pending → draft），便于重新编辑后再发布。
  async function handleUnpublish(task: Task) {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unpublish" })
    });
    if (response.ok) setRefreshKey((prev) => prev + 1);
  }

  // 关键词 debounce，避免每敲一个字符就发一次请求
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  // 任一筛选条件变化都回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [status, projectId, workerId, debouncedQ, dir, pageSize]);

  // worker 下拉数据：取全集仅用于过滤展示，离线 worker 也保留（历史任务仍要可定位）。
  // worker 注册/离线属低频事件，挂载拉一次即可，不必因任意 relay 事件被动刷新（Infinity = 关闭所有自动刷新源）。
  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/workers", { cache: "no-store" });
      if (!response.ok) return;
      const json = (await response.json()) as { workers: Worker[] };
      if (isActive()) setWorkers(json.workers);
    } catch {
      /* 轮询失败静默 */
    }
  }, [], Infinity);

  usePolling(
    async (isActive) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (projectId) params.set("projectId", projectId);
      if (workerId) params.set("workerId", workerId);
      if (debouncedQ) params.set("q", debouncedQ);
      params.set("dir", dir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      try {
        const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) return;
        const json = (await response.json()) as ListResponse;
        if (isActive()) {
          setData(json);
          if (json.stats) setSidebarStats(json.stats);
        }
      } catch {
        /* 轮询失败静默，下次重试 */
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [status, projectId, workerId, debouncedQ, dir, page, pageSize, refreshKey],
    Infinity
  );

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  // 结果收窄导致当前页越界时回拉到末页
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const hasFilter = Boolean(status || projectId || workerId || debouncedQ);

  return (
    <>
      <div className="page-head">
        <h1 className="page-head-title">任务调度</h1>
        <div className="page-head-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setRefreshKey((prev) => prev + 1)}
            title="刷新"
          >
            <RefreshCw size={16} />
            刷新
          </button>
          {canCreateTask ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onOpenCompose}
              disabled={projects.length === 0}
            >
              <Plus size={16} />
              新建任务
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
                <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="搜索标题或工作分支" />
              </div>
              <Select
                className="tb-select"
                value={status}
                onChange={setStatus}
                options={STATUS_FILTERS}
                ariaLabel="按状态筛选"
              />
              <Select
                className="tb-select"
                value={projectId}
                onChange={setProjectId}
                options={[
                  { value: "", label: "全部项目" },
                  ...projects.map((project) => ({ value: project.id, label: project.name }))
                ]}
                ariaLabel="按项目筛选"
              />
              <Select
                className="tb-select"
                value={workerId}
                onChange={setWorkerId}
                options={[
                  { value: "", label: "全部 Worker" },
                  ...workers.map((worker) => ({ value: worker.id, label: worker.name }))
                ]}
                ariaLabel="按 Worker 筛选"
              />
            </div>

            <div className="card-body flush">
              {data.tasks.length === 0 ? (
                <Empty
                  icon={<Inbox size={28} />}
                  text={loading ? "加载中…" : hasFilter ? "没有符合条件的任务" : "暂无任务，点击右上角发布第一个任务"}
                />
              ) : (
                <div className="table-wrap scroll-rows-10">
                  <table className="table table-static">
                    <thead>
                      <tr>
                        <th>任务</th>
                        <th>项目</th>
                        <th>分支</th>
                        <th>状态</th>
                        <th>Worker</th>
                        <th>PR</th>
                        <th
                          style={{ cursor: "pointer", userSelect: "none" }}
                          onClick={() => setDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                          title="点击切换更新时间排序"
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            更新
                            {dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                          </span>
                        </th>
                        <th className="t-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tasks.map((task) => {
                        const rowCanEdit = canCreateTask && (task.status === "draft" || task.status === "scheduled");
                        const rowCanDelete = canCreateTask && task.status !== "claimed" && task.status !== "running";
                        const rowCanUnpublish = canCreateTask && task.status === "pending";
                        const prNumber = parsePrNumber(task.pr_url);
                        return (
                          <tr key={task.id}>
                            <td>
                              <span className="t-title">{task.title}</span>
                            </td>
                            <td className="t-meta">
                              <span className="cell-icon">
                                <FolderGit2 size={13} className="ico" />
                                {task.project_name ?? task.project_id}
                              </span>
                            </td>
                            <td className="mono">
                              <span className="cell-icon">
                                <GitBranch size={13} className="ico" />
                                {task.work_branch}
                              </span>
                            </td>
                            <td>
                              <StatusBadge status={task.status} />
                            </td>
                            <td className="t-meta">
                              {task.worker_name ? (
                                <span className="cell-icon">
                                  <Cpu size={13} className="ico" />
                                  {task.worker_name}
                                </span>
                              ) : (
                                <span className="cell-muted">—</span>
                              )}
                            </td>
                            <td className="t-meta">
                              {task.pr_url ? (
                                <a className="cell-icon" href={task.pr_url} target="_blank" rel="noreferrer">
                                  <GitPullRequest size={13} className="ico" />
                                  {prNumber != null ? `#${prNumber}` : "PR"}
                                </a>
                              ) : (
                                <span className="cell-muted">—</span>
                              )}
                            </td>
                            <td className="t-num">{fmtDateTime(task.updated_at)}</td>
                            <td className="t-right">
                              <div className="row-actions">
                                <button
                                  type="button"
                                  className="icon-btn"
                                  title="查看"
                                  onClick={() => onOpenTask(task)}
                                >
                                  <Eye size={14} />
                                </button>
                                {rowCanUnpublish ? (
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    title="退回草稿"
                                    onClick={() => void handleUnpublish(task)}
                                  >
                                    <RotateCcw size={14} />
                                  </button>
                                ) : null}
                                {rowCanEdit ? (
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    title="编辑"
                                    onClick={() => setEditingTask(task)}
                                  >
                                    <Pencil size={14} />
                                  </button>
                                ) : null}
                                {rowCanDelete ? (
                                  <button
                                    type="button"
                                    className="icon-btn danger"
                                    title="删除"
                                    onClick={() => void handleDelete(task)}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {data.total > 0 ? (
              <div className="pager">
                <span className="pager-info">
                  第 {Math.min(page, totalPages)} / {totalPages} 页 · 共 {data.total} 条
                </span>
                <div className="pager-controls">
                  <Select
                    className="pager-select"
                    value={String(pageSize)}
                    onChange={(value) => setPageSize(Number(value))}
                    options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `每页 ${size} 条` }))}
                    ariaLabel="每页条数"
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page <= 1}
                    onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  >
                    <ChevronLeft size={16} />
                    上一页
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                  >
                    下一页
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </main>

        <aside className="page-grid-aside">
          <TasksSidebar stats={sidebarStats} />
        </aside>
      </div>

      <FormModal
        open={editingTask !== null}
        title={editingTask ? `编辑 ${editingTask.title}` : ""}
        onClose={() => setEditingTask(null)}
      >
        {editingTask ? (
          <TaskEditForm
            key={editingTask.id}
            task={editingTask}
            onSaved={() => {
              setEditingTask(null);
              setRefreshKey((prev) => prev + 1);
            }}
            onCancel={() => setEditingTask(null)}
          />
        ) : null}
      </FormModal>

      {dialog}
    </>
  );
}

// 项目饼图色板：按项目顺序循环取色（与 Tone 同源 CSS 变量，与状态色互不冲突）。
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

// 极坐标→笛卡尔（pie sector 起止点）。angle 单位：度，0° 在 12 点钟方向、顺时针递增。
function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

// 任务概览饼图：按项目划分（实心扇形 + 右侧 legend）。0 项目时调用方走 Empty。
function ProjectPie({ data, total }: { data: { id: string; name: string; n: number }[]; total: number }) {
  const size = 128;
  const r = size / 2;
  const cx = r;
  const cy = r;

  // 单一项目时 path 退化（>=360° 会算出同一点导致不可见），用整圆替代。
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

// 任务流右侧栏：任务概览（项目饼图） / 状态分布（环状图） / 今日统计（三列）。
// stats 由父组件 TasksView 随任务列表刷新一并传入。
function TasksSidebar({ stats }: { stats: TaskStatsPayload | null }) {
  const total = stats?.total ?? 0;
  const byStatus = stats?.byStatus ?? {};
  const byProject = stats?.byProject ?? [];

  // 状态分布：按 STATUS_ORDER 排序、过滤 0 计数；段 tone 沿用 STATUS_META。
  const statusSegments = STATUS_ORDER
    .map((key) => ({ key, n: byStatus[key] ?? 0 }))
    .filter((row) => row.n > 0)
    .map((row) => {
      const meta = metaOf(row.key);
      return { status: row.key, label: meta.label, tone: meta.tone, value: row.n };
    });

  const today = stats?.today ?? { created: 0, finished: 0, accepted: 0, rejected: 0, avgDurationMs: null };
  const completionRate = today.finished > 0
    ? `${Math.round((today.accepted / today.finished) * 1000) / 10}%`
    : "—";

  return (
    <>
      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><ListTodo size={15} /></span>
          <h3 className="section-title">任务概览</h3>
        </div>
        <div className="section-body">
          {byProject.length === 0 ? (
            <Empty icon={<ListTodo size={22} />} text="暂无任务" />
          ) : (
            <ProjectPie data={byProject} total={total} />
          )}
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><Activity size={15} /></span>
          <h3 className="section-title">状态分布</h3>
        </div>
        <div className="section-body">
          {statusSegments.length === 0 ? (
            <Empty icon={<Activity size={22} />} text="暂无数据" />
          ) : (
            <Donut segments={statusSegments} total={total} />
          )}
        </div>
      </section>

      <section className="card sidebar-card">
        <div className="section-head">
          <span className="section-ico"><Clock size={15} /></span>
          <h3 className="section-title">今日统计</h3>
        </div>
        <div className="section-body">
          <div className="sb-stat-cols">
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">创建任务</span>
              <span className="sb-stat-col-value">{today.created}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">完成任务</span>
              <span className="sb-stat-col-value">{completionRate}</span>
            </div>
            <div className="sb-stat-col">
              <span className="sb-stat-col-label">平均耗时</span>
              <span className="sb-stat-col-value">{fmtDurationMs(today.avgDurationMs)}</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

export { TasksView, TaskComposeModal };
