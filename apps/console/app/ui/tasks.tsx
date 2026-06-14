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
  type CurrentUser, type Health, type Overview, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";


type ListResponse = { tasks: Task[]; total: number; page: number; pageSize: number };

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

const MERGE_STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部合并状态" },
  { value: "unknown", label: "未检查" },
  { value: "unmerged", label: "未合并" },
  { value: "merged", label: "已合并" }
];

const PAGE_SIZE_OPTIONS = [20, 50, 100];

function TasksView({
  overview,
  onOpenTask,
  onOpenCompose,
  canCreateTask
}: {
  overview: Overview;
  onOpenTask: (task: Task) => void;
  onOpenCompose: () => void;
  canCreateTask: boolean;
}) {
  const [status, setStatus] = useState("");
  const [mergeStatus, setMergeStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  // 列表固定按更新时间排序，方向由「更新」表头切换（默认降序）。
  const [dir, setDir] = useState<SortDir>("desc");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse>({ tasks: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);

  // 关键词 debounce，避免每敲一个字符就发一次请求
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [q]);

  // 任一筛选条件变化都回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [status, mergeStatus, projectId, debouncedQ, dir, pageSize]);

  usePolling(
    async (isActive) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (mergeStatus) params.set("mergeStatus", mergeStatus);
      if (projectId) params.set("projectId", projectId);
      if (debouncedQ) params.set("q", debouncedQ);
      params.set("dir", dir);
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      try {
        const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
        if (!response.ok) return;
        const json = (await response.json()) as ListResponse;
        if (isActive()) setData(json);
      } catch {
        /* 轮询失败静默，下次重试 */
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [status, mergeStatus, projectId, debouncedQ, dir, page, pageSize]
  );

  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  // 结果收窄导致当前页越界时回拉到末页
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const hasFilter = Boolean(status || mergeStatus || projectId || debouncedQ);

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">任务流</h2>
          <span className="section-sub">{data.total} 个任务 · 点击行查看详情</span>
        </div>
        {canCreateTask ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onOpenCompose}
            disabled={overview.projects.length === 0}
          >
            <Plus size={16} />
            发布任务
          </button>
        ) : null}
      </div>

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
            value={mergeStatus}
            onChange={setMergeStatus}
            options={MERGE_STATUS_FILTERS}
            ariaLabel="按合并状态筛选"
          />
          <Select
            className="tb-select"
            value={projectId}
            onChange={setProjectId}
            options={[
              { value: "", label: "全部项目" },
              ...overview.projects.map((project) => ({ value: project.id, label: project.name }))
            ]}
            ariaLabel="按项目筛选"
          />
        </div>

        <div className="card-body flush">
          {data.tasks.length === 0 ? (
            <Empty
              icon={<Inbox size={28} />}
              text={loading ? "加载中…" : hasFilter ? "没有符合条件的任务" : "暂无任务，点击右上角发布第一个任务"}
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>任务</th>
                    <th>项目</th>
                    <th>分支</th>
                    <th>合并</th>
                    <th
                      className="t-right"
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => setDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                      title="点击切换更新时间排序"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        更新
                        {dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.map((task) => (
                    <tr key={task.id} onClick={() => onOpenTask(task)}>
                      <td>
                        <StatusBadge status={task.status} />
                      </td>
                      <td>
                        <span className="t-title">{task.title}</span>
                      </td>
                      <td className="t-meta">{task.project_name ?? task.project_id}</td>
                      <td className="mono">{task.work_branch}</td>
                      <td><MergeStatusBadge status={task.merge_status} /></td>
                      <td className="t-right t-num">{fmtDateTime(task.updated_at)}</td>
                    </tr>
                  ))}
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
    </>
  );
}

function ComposeTaskForm({
  overview,
  busy,
  selectedProjectId,
  onSelectProject,
  onSubmit
}: {
  overview: Overview;
  busy: boolean;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [submitMode, setSubmitMode] = useState<"pr" | "push">("pr");
  const [autoMergePr, setAutoMergePr] = useState(false);
  const [model, setModel] = useState<"default" | "opus" | "sonnet" | "haiku">("default");

  useEffect(() => {
    if (!selectedProjectId) {
      setBranches([]);
      setBranchState("idle");
      return;
    }
    let active = true;
    setBranchState("loading");
    fetch(`/api/projects/${selectedProjectId}/branches`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { branches: string[] };
        if (active) {
          setBranches(data.branches);
          setBranchState("idle");
        }
      })
      .catch(() => {
        if (active) {
          setBranches([]);
          setBranchState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId]);

  const branchHint =
    branchState === "loading"
      ? "拉取分支中…"
      : branchState === "error"
        ? "拉取失败，可手填"
        : branches.length > 0
          ? `${branches.length} 个远程分支`
          : "可手动输入";

  // 前置任务候选：同项目、未取消（取消的任务无法被验收，选它会导致后置永久阻塞）。
  const dependencyCandidates = overview.tasks.filter(
    (task) => task.project_id === selectedProjectId && task.status !== "cancelled"
  );

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label">项目</label>
        <Select
          value={selectedProjectId}
          onChange={onSelectProject}
          options={overview.projects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="选择项目"
          ariaLabel="项目"
        />
      </div>
      <div className="field">
        <label className="field-label">标题</label>
        <input name="title" placeholder="修复登录按钮状态" required />
      </div>
      <div className="field">
        <label className="field-label">目标</label>
        <textarea
          name="description"
          rows={4}
          placeholder="写清期望行为、约束和验收方式"
          required
        />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">
            签出分支 <span className="field-hint">{branchHint}</span>
          </label>
          <input name="baseBranch" list="cc-branch-list" defaultValue="main" placeholder="main" />
        </div>
        <div className="field">
          <label className="field-label">
            PR 目标分支 <span className="field-hint">留空同签出分支</span>
          </label>
          <input name="targetBranch" list="cc-branch-list" placeholder="main" />
        </div>
      </div>
      <datalist id="cc-branch-list">
        {branches.map((branch) => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
      <div className="form-row">
        <div className="field">
          <label className="field-label">
            工作分支 <span className="field-hint">留空自动生成</span>
          </label>
          <input name="workBranch" placeholder="cc/..." />
        </div>
        <div className="field">
          <label className="field-label">提交模式</label>
          <Select
            name="submitMode"
            value={submitMode}
            onChange={(value) => setSubmitMode(value as "pr" | "push")}
            options={[
              { value: "pr", label: "创建 PR" },
              { value: "push", label: "直接提交推送" }
            ]}
            ariaLabel="提交模式"
          />
        </div>
      </div>
      {submitMode === "pr" ? (
        <div className="field">
          <label className="field-label">
            自动合并 PR <span className="field-hint">PR 创建后由 Worker 自动 gh pr merge --merge</span>
          </label>
          <Select
            name="autoMergePr"
            value={autoMergePr ? "on" : "off"}
            onChange={(value) => setAutoMergePr(value === "on")}
            options={[
              { value: "off", label: "否 · 仅创建 PR" },
              { value: "on", label: "是 · 创建后自动合并" }
            ]}
            ariaLabel="自动合并 PR"
          />
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">
          执行模型 <span className="field-hint">该任务执行时用哪个 Claude 模型，默认跟随 Worker</span>
        </label>
        <Select
          name="model"
          value={model}
          onChange={(value) => setModel(value as "default" | "opus" | "sonnet" | "haiku")}
          options={[
            { value: "default", label: "默认 · 跟随 Worker" },
            { value: "opus", label: "Opus" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" }
          ]}
          ariaLabel="执行模型"
        />
      </div>
      <div className="field">
        <label className="field-label">
          定时发布 <span className="field-hint">留空即建为草稿手动发布；设定时间则到点自动进入待处理队列</span>
        </label>
        <input name="scheduledAt" type="datetime-local" />
      </div>
      <div className="field">
        <label className="field-label">
          前置任务 <span className="field-hint">同项目，可多选；前置全部「已验收 / 已合并」后才会被领取</span>
        </label>
        {dependencyCandidates.length === 0 ? (
          <span className="field-hint">该项目暂无可作为前置的任务</span>
        ) : (
          <select name="dependsOn" multiple size={Math.min(6, Math.max(3, dependencyCandidates.length))}>
            {dependencyCandidates.map((task) => (
              <option key={task.id} value={task.id}>
                [{metaOf(task.status).label}] {task.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <button className="btn btn-primary" disabled={busy || overview.projects.length === 0} type="submit">
        <Send size={16} />
        入队
      </button>
    </form>
  );
}

function TaskDrawer({
  open,
  busy,
  overview,
  selectedProjectId,
  onClose,
  onSelectProject,
  onSubmitTask,
  canCreateTask
}: {
  open: boolean;
  busy: boolean;
  overview: Overview;
  selectedProjectId: string;
  onClose: () => void;
  onSelectProject: (id: string) => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  canCreateTask: boolean;
}) {
  // 仅用于「发布任务」表单；任务详情已迁至独立路由页 /tasks/[id]。
  return (
    <Drawer open={open} title={canCreateTask ? "发布任务" : ""} onClose={onClose}>
      {canCreateTask ? (
        <ComposeTaskForm
          overview={overview}
          busy={busy}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onSubmit={onSubmitTask}
        />
      ) : null}
    </Drawer>
  );
}


export { TasksView, TaskDrawer };
