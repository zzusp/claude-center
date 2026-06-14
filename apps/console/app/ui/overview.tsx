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
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot, TaskTypeBadge,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type Overview, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";


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
                          <td className="mono">{task.task_type === "qa" ? "对话" : task.work_branch}</td>
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
function SyncStatus({
  synced,
  message,
  lastSyncAt
}: {
  synced: boolean;
  message: string;
  lastSyncAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const ago = synced && lastSyncAt ? syncAgo(lastSyncAt, now) : null;

  return (
    <span className="sync" data-live={synced ? "on" : "off"}>
      <span className={`dot${synced ? " pulse" : ""}`} data-tone={synced ? "online" : "offline"} />
      <span className="sync-text">{message}</span>
      {ago ? (
        <span className="sync-ago" key={lastSyncAt}>
          · {ago}
        </span>
      ) : null}
    </span>
  );
}

function RuntimeHealth({
  health,
  synced,
  lastSyncAt
}: {
  health: Health | null;
  synced: boolean;
  lastSyncAt: string | null;
}) {
  const db = health?.db;
  const sched = health?.scheduler;
  const intervalSec = sched?.intervalMs ? Math.round(sched.intervalMs / 1000) : null;

  return (
    <section className="health-section">
      <div className="section-head">
        <h2 className="section-title">系统运行状态</h2>
        <span className="section-sub">数据库 · 调度器 · 实时同步</span>
      </div>
      <div className="grid-3">
        <HealthCard
          icon={<Database size={16} />}
          title="数据库连接"
          ok={db?.ok ?? false}
          okLabel={db?.ok ? "已连接" : "未连接"}
          rows={[
            { k: "往返延迟", v: db?.latencyMs != null ? `${db.latencyMs} ms` : "—" },
            { k: "连接池", v: db ? `${db.pool.total} / ${db.pool.max}（空闲 ${db.pool.idle}）` : "—" },
            { k: "等待队列", v: db ? `${db.pool.waiting}` : "—" }
          ]}
        />
        <HealthCard
          icon={<Clock size={16} />}
          title="定时调度器"
          ok={sched?.ok ?? false}
          okLabel={sched?.ok ? "运行中" : sched?.startedAt ? "异常" : "未启动"}
          rows={[
            { k: "检查周期", v: intervalSec != null ? `每 ${intervalSec}s` : "—" },
            { k: "上次检查", v: sched?.lastTickAt ? fmtAgo(sched.lastTickAt) : "—" },
            { k: "定时待发", v: sched ? `${sched.scheduledPending} 个` : "—" },
            { k: "累计提升", v: sched ? `${sched.totalPromoted} 个` : "—" },
            ...(sched?.lastError ? [{ k: "最近错误", v: sched.lastError, mono: true }] : [])
          ]}
        />
        <HealthCard
          icon={<RadioTower size={16} />}
          title="实时同步"
          ok={synced}
          okLabel={synced ? "同步中" : "已断开"}
          rows={[
            { k: "轮询节奏", v: `每 ${Math.round(POLL_INTERVAL_MS / 1000)}s` },
            { k: "上次同步", v: lastSyncAt ? fmtAgo(lastSyncAt) : "—" }
          ]}
        />
      </div>
    </section>
  );
}

function HealthCard({
  icon,
  title,
  ok,
  okLabel,
  rows
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean;
  okLabel: string;
  rows: { k: string; v: React.ReactNode; mono?: boolean }[];
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <span className="ico">{icon}</span>
          {title}
        </h2>
        <span className="badge" data-tone={ok ? "success" : "failed"}>
          <span className="glyph">{ok ? "●" : "✕"}</span>
          {okLabel}
        </span>
      </div>
      <div className="card-body health-body">
        {rows.map((row) => (
          <KvRow key={row.k} k={row.k} v={row.v} mono={row.mono} />
        ))}
      </div>
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  total,
  footLabel,
  series,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  total?: number;
  footLabel?: string;
  series: number[];
  tone: Tone;
}) {
  const prev = series.length >= 2 ? series[series.length - 2] ?? value : value;
  const delta = value - prev;
  const trend = delta === 0 ? "较昨日 持平" : `较昨日 ${delta > 0 ? "+" : "-"}${Math.abs(delta)}`;
  return (
    <article className="stat-card">
      <div className="stat-head">
        <span className="ico" style={{ color: TONE_COLOR[tone] }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="stat-value">
        {value}
        {typeof total === "number" ? <span className="unit">/ {total}</span> : null}
      </div>
      <div className="stat-foot">
        <span className="stat-trend">{footLabel ?? trend}</span>
        <Sparkline data={series} tone={tone} />
      </div>
    </article>
  );
}

function Sparkline({ data, tone }: { data: number[]; tone: Tone }) {
  const w = 96;
  const h = 28;
  const color = TONE_COLOR[tone];
  if (data.length < 2) {
    return (
      <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <line x1={0} y1={h - 2} x2={w} y2={h - 2} stroke={color} strokeWidth={1.5} opacity={0.4} />
      </svg>
    );
  }
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * w;
    const y = h - 2 - ((value - min) / range) * (h - 6);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const last = points[points.length - 1]!;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}

function Donut({
  segments,
  total
}: {
  segments: { label: string; tone: Tone; value: number; status: string }[];
  total: number;
}) {
  const size = 128;
  const stroke = 16;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="donut-wrap">
      <div className="donut-center" style={{ width: size, height: size }}>
        <svg className="donut" width={size} height={size}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-2)"
            strokeWidth={stroke}
          />
          {segments.map((segment) => {
            const length = (segment.value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const node = (
              <circle
                key={segment.status}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={TONE_COLOR[segment.tone]}
                strokeWidth={stroke}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
              />
            );
            offset += length;
            return node;
          })}
        </svg>
        <div className="donut-total">
          <div className="n">{total}</div>
          <div className="l">任务</div>
        </div>
      </div>
      <div className="legend">
        {segments.map((segment) => (
          <div className="legend-item" key={segment.status}>
            <span className="dot" data-tone={segment.tone} />
            <span className="legend-label">{segment.label}</span>
            <span className="legend-val">{segment.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


export { DashboardView, SyncStatus };
