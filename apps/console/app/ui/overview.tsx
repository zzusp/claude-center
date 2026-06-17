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
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, GitMerge, Inbox, LayoutGrid, ListTodo,
  LogOut, MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send,
  Server, ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, syncAgo,
  type CurrentUser, type Health, type Overview, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";
import { Donut, RuntimeHealth, StatCard } from "./overview-widgets";
import { WorkingStateBadge } from "./worker-shared";


// Worker 行内并发用量指示：active/max 的 mini bar + "x/y" 文案。
// max<=0 不渲染（异常配置时不喧宾夺主）；active 被 clamp 到 [0, max] 防止越界。
// tone 阈值：满载 failed，≥70% pending，其余 success——跟 sm-chip-usage 一致。
function WorkerUsage({ active, max }: { active: number; max: number }) {
  if (!Number.isFinite(max) || max <= 0) return null;
  const safeActive = Math.max(0, Math.min(active, max));
  const pct = Math.round((safeActive / max) * 100);
  const tone = safeActive >= max ? "failed" : safeActive >= Math.max(1, Math.round(max * 0.7)) ? "pending" : "success";
  return (
    <span className="worker-usage" data-tone={tone} title={`并发 ${safeActive} / ${max}`}>
      <span className="worker-usage-bar">
        <span className="worker-usage-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="worker-usage-text">
        {safeActive}/{max}
      </span>
    </span>
  );
}

function DashboardView({
  overview,
  history,
  statusCounts,
  synced,
  lastSyncAt,
  loaded,
  onOpenTask
}: {
  overview: Overview;
  history: Record<"online", number[]>;
  statusCounts: Record<string, number>;
  synced: boolean;
  lastSyncAt: string | null;
  loaded: boolean;
  onOpenTask: (task: Task) => void;
}) {
  // 首次响应未到达：渲染骨架而非 emptyOverview 派生出的"失败任务 0 / 未连接 / 暂无任务"——
  // 那些是确定结论的视觉，会让用户误以为系统已坏 / 没数据，应当区分"加载中"与"真实空态/异常"。
  if (!loaded) {
    return <DashboardSkeleton />;
  }

  const recentTasks = overview.tasks.slice(0, 7);
  const failedTasks = overview.tasks.filter((task) => task.status === "failed").slice(0, 4);

  const donutSegments = (
    [
      "running",
      "waiting",
      "pending",
      "scheduled",
      "draft",
      "claimed",
      "success",
      "merged",
      "failed",
      "cancelled"
    ] as const
  )
    .map((status) => ({
      status,
      label: metaOf(status).label,
      tone: metaOf(status).tone,
      value: statusCounts[status] ?? 0
    }))
    .filter((segment) => segment.value > 0);
  const donutTotal = donutSegments.reduce((sum, segment) => sum + segment.value, 0);

  return (
    <>
      <div className="grid-stats">
        <StatCard
          icon={<Cpu size={16} />}
          label="在线 Worker"
          value={overview.summary.onlineWorkers}
          total={overview.workers.length}
          footLabel={`${
            overview.workers.length > 0
              ? Math.round((overview.summary.onlineWorkers / overview.workers.length) * 100)
              : 0
          }% 在线率`}
          series={history.online}
          tone="success"
        />
        <StatCard
          icon={<ListTodo size={16} />}
          label="今日新任务"
          value={overview.summary.todayNewTasks}
          series={overview.dailyNewTasks}
          tone="pending"
        />
        <StatCard
          icon={<Check size={16} />}
          label="今日完成"
          value={overview.summary.todayCompletedTasks}
          series={overview.dailyCompletedTasks}
          tone="success"
        />
        <StatCard
          icon={<GitMerge size={16} />}
          label="今日合并"
          value={overview.summary.todayMergedTasks}
          series={overview.dailyMergedTasks}
          tone="merged"
        />
      </div>

      <RuntimeHealth health={overview.health} synced={synced} lastSyncAt={lastSyncAt} />

      <div className="grid-2">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <Activity size={16} className="ico" />
                最近任务流
              </h2>
              <span className="card-tools">最新 {recentTasks.length} 条</span>
            </div>
            <div className="card-body flush">
              {recentTasks.length === 0 ? (
                <Empty icon={<Inbox size={28} />} text="暂无任务" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>状态</th>
                        <th>任务</th>
                        <th>分支</th>
                        <th className="t-right">更新</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentTasks.map((task) => (
                        <tr key={task.id} onClick={() => onOpenTask(task)}>
                          <td>
                            <StatusBadge status={task.status} />
                          </td>
                          <td>
                            <div className="cell-stack">
                              <span className="t-title">{task.title}</span>
                              <span className="t-meta">{task.project_name ?? task.project_id}</span>
                            </div>
                          </td>
                          <td className="mono">{task.work_branch}</td>
                          <td className="t-right t-num">{fmtTime(task.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          {failedTasks.length > 0 ? (
            <section className="card">
              <div className="card-head">
                <h2 className="card-title">
                  <CircleAlert size={16} className="ico" />
                  异常提示
                </h2>
                <span className="card-tools">{failedTasks.length} 个失败任务</span>
              </div>
              <div className="card-body">
                <div className="kv">
                  {failedTasks.map((task) => (
                    <div className="kv-row" key={task.id} style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
                      <div>
                        <div className="t-title" style={{ maxWidth: "none" }}>
                          {task.title}
                        </div>
                        <div className="error-box">{task.error_message ?? "未知错误"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          ) : null}
        </div>

        <div className="col">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <ListTodo size={16} className="ico" />
                任务状态分布
              </h2>
            </div>
            <div className="card-body">
              {donutTotal === 0 ? (
                <Empty icon={<Inbox size={28} />} text="暂无任务" />
              ) : (
                <Donut segments={donutSegments} total={donutTotal} />
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">
                <Server size={16} className="ico" />
                Worker 概览
              </h2>
              <span className="card-tools">
                {overview.summary.onlineWorkers}/{overview.workers.length} 在线
              </span>
            </div>
            <div className="card-body">
              {overview.workers.length === 0 ? (
                <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
              ) : (
                <div className="worker-rows">
                  {overview.workers.slice(0, 6).map((worker) => (
                    <div className="worker-row" data-layout="split" key={worker.id}>
                      <StatusDot status={worker.status} pulse={worker.status === "online"} />
                      <span className="v" style={{ color: "var(--text-1)", fontWeight: 600 }}>
                        {worker.name}
                      </span>
                      <span className="v mono" title={`claude ${worker.claude_version ?? "未知"}`}>
                        claude {worker.claude_version ?? "—"}
                      </span>
                      <WorkingStateBadge state={worker.working_state} />
                      <WorkerUsage active={worker.active_task_count ?? 0} max={worker.max_parallel} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

// 总览骨架：与真实版式严格对齐（grid-stats + health-section + grid-2），
// 仅替换字段为灰块占位 + cc-skeleton 呼吸闪烁动画，避免"未连接 / 失败任务 0 / 暂无任务"误读。
function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="grid-stats">
        {Array.from({ length: 4 }).map((_, i) => (
          <article className="stat-card" key={i}>
            <div className="stat-head">
              <span style={skeletonStyle(16, 16, "50%")} />
              <span style={skeletonStyle(72, 13)} />
            </div>
            <div className="stat-value">
              <span style={skeletonStyle(56, 32)} />
            </div>
            <div className="stat-foot">
              <span style={skeletonStyle(80, 12)} />
              <span style={skeletonStyle(96, 24)} />
            </div>
          </article>
        ))}
      </div>

      <section className="health-section">
        <div className="section-head">
          <span style={skeletonStyle(120, 16)} />
          <span style={skeletonStyle(160, 13)} />
        </div>
        <div className="grid-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <section className="card" key={i}>
              <div className="card-head">
                <span style={skeletonStyle(120, 16)} />
                <span style={skeletonStyle(64, 20, 999)} />
              </div>
              <div className="card-body health-body">
                {Array.from({ length: 3 }).map((__, j) => (
                  <div
                    key={j}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12
                    }}
                  >
                    <span style={skeletonStyle(72, 12)} />
                    <span style={skeletonStyle(96, 12)} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <div className="col">
          <section className="card">
            <div className="card-head">
              <span style={skeletonStyle(112, 16)} />
              <span style={skeletonStyle(64, 12)} />
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "64px minmax(0,1fr) 120px 80px",
                    gap: 12,
                    alignItems: "center"
                  }}
                >
                  <span style={skeletonStyle(56, 18, 999)} />
                  <span style={skeletonStyle("80%", 14)} />
                  <span style={skeletonStyle("100%", 12)} />
                  <span style={skeletonStyle(60, 12)} />
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="col">
          <section className="card">
            <div className="card-head">
              <span style={skeletonStyle(112, 16)} />
            </div>
            <div
              className="card-body"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}
            >
              <span style={skeletonStyle(128, 128, "50%")} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 120 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <span key={i} style={skeletonStyle("100%", 12)} />
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <span style={skeletonStyle(96, 16)} />
              <span style={skeletonStyle(48, 12)} />
            </div>
            <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={skeletonStyle(8, 8, "50%")} />
                  <span style={skeletonStyle("60%", 14)} />
                  <span style={{ ...skeletonStyle(56, 12), marginLeft: "auto" }} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function skeletonStyle(width: number | string, height: number, radius: number | string = 6): React.CSSProperties {
  return {
    display: "inline-block",
    width: typeof width === "number" ? `${width}px` : width,
    height: `${height}px`,
    borderRadius: typeof radius === "number" ? `${radius}px` : radius,
    background: "var(--surface-2)",
    animation: "cc-skeleton 1.4s ease-in-out infinite"
  };
}

export { DashboardView };
export { SyncStatus, RelayStatus } from "./overview-widgets";
