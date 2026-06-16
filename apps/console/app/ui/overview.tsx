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
import { Donut, RuntimeHealth, StatCard } from "./overview-widgets";


function DashboardView({
  overview,
  history,
  statusCounts,
  synced,
  lastSyncAt,
  onOpenTask
}: {
  overview: Overview;
  history: Record<"online" | "pending" | "running" | "failed", number[]>;
  statusCounts: Record<string, number>;
  synced: boolean;
  lastSyncAt: string | null;
  onOpenTask: (task: Task) => void;
}) {
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
      "accepted",
      "rejected",
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
          label="待处理任务"
          value={overview.summary.pendingTasks}
          series={history.pending}
          tone="pending"
        />
        <StatCard
          icon={<Activity size={16} />}
          label="执行中"
          value={overview.summary.runningTasks}
          series={history.running}
          tone="running"
        />
        <StatCard
          icon={<CircleAlert size={16} />}
          label="失败任务"
          value={overview.summary.failedTasks}
          series={history.failed}
          tone="failed"
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
                    <div className="worker-row" key={worker.id}>
                      <StatusDot status={worker.status} pulse={worker.status === "online"} />
                      <span className="v" style={{ color: "var(--text-1)", fontWeight: 600 }}>
                        {worker.name}
                      </span>
                      <span className="v mono" style={{ marginLeft: "auto" }}>
                        {fmtAgo(worker.last_seen_at)}
                      </span>
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

export { DashboardView };
export { SyncStatus, RelayStatus } from "./overview-widgets";
