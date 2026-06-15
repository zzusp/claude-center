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
  Worker,
  WorkerProjectLinkView
} from "@claude-center/db";
import {
  Activity, ArrowDown, ArrowUp, Boxes, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson, type Tone
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, TONE_COLOR, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";


// 订阅类型展示：套餐档位 vs API 计费。isPlan 决定是否展示用量。
const SUBSCRIPTION_LABEL: Record<string, string> = {
  max: "套餐订阅 · Max",
  pro: "套餐订阅 · Pro",
  team: "套餐订阅 · Team",
  enterprise: "套餐订阅 · Enterprise",
  api: "API 计费",
  unknown: "未识别"
};

function subscriptionLabel(type: string): string {
  return SUBSCRIPTION_LABEL[type] ?? type;
}

function isPlanSubscription(type: string): boolean {
  return type !== "api" && type !== "unknown";
}

// 用量窗口重置倒计时：oauth/usage 给的是 resets_at 绝对时间，这里换算成剩余。
function fmtResetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "已重置";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function WorkingStateBadge({ state }: { state: string }) {
  const working = state === "working";
  return (
    <span className="badge" data-tone={working ? "success" : "pending"}>
      <span className="glyph">{working ? "▶" : "⏸"}</span>
      {working ? "工作中" : "空闲"}
    </span>
  );
}

// 套餐用量条：oauth/usage 只给利用率百分比（已用/总额度的比例）+ 重置时间，无绝对额度。
function UsageBlock({ label, win }: { label: string; win: { utilization: number; resets_at: string } }) {
  const pct = Math.max(0, Math.min(100, win.utilization));
  const tone: Tone = pct >= 90 ? "failed" : pct >= 70 ? "pending" : "success";
  return (
    <div className="usage-block">
      <div className="usage-head">
        <span>{label}</span>
        <span className="pct">
          已用 {pct.toFixed(0)}% · 重置剩余 {fmtResetIn(win.resets_at)}
        </span>
      </div>
      <div className="usage-track">
        <div className="usage-fill" style={{ width: `${pct}%`, background: TONE_COLOR[tone] }} />
      </div>
    </div>
  );
}

function WorkersView({
  workers,
  canCommand,
  onDeleted
}: {
  workers: Worker[];
  canCommand: boolean;
  onDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const onlineWorkers = workers.filter((worker) => worker.status === "online").length;

  function displayName(worker: Worker): string {
    return worker.label || worker.name;
  }

  // 卡片本身可点击跳详情，删除按钮需阻止冒泡；二次确认后调后端 DELETE，成功后乐观移除。
  async function handleDelete(event: MouseEvent, worker: Worker) {
    event.stopPropagation();
    if (!window.confirm(`确认删除 Worker「${displayName(worker)}」？此操作不可撤销，关联的任务事件历史会保留（仅置空 worker 引用）。`)) {
      return;
    }
    try {
      const res = await fetch(`/api/workers/${worker.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "删除失败");
      }
      onDeleted(worker.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">执行机群</h2>
          <span className="section-sub">
            {onlineWorkers}/{workers.length} 在线 · 心跳 60s 超时判离线 · 在线≠接任务
          </span>
        </div>
      </div>

      {workers.length === 0 ? (
        <section className="card">
          <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
        </section>
      ) : (
        <div className="worker-grid">
          {workers.map((worker) => {
            return (
              <article
                className="worker-card"
                key={worker.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/workers/${worker.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    router.push(`/workers/${worker.id}`);
                  }
                }}
              >
                <div className="worker-top">
                  <StatusDot status={worker.status} pulse={worker.status === "online"} />
                  <span className="worker-name">{displayName(worker)}</span>
                  <StatusBadge status={worker.status} />
                  <WorkingStateBadge state={worker.working_state} />
                  {canCommand && (
                    <button
                      type="button"
                      className="btn-icon"
                      title="删除 Worker"
                      style={{ marginLeft: "auto", color: "var(--failed)" }}
                      onClick={(event) => handleDelete(event, worker)}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <div className="worker-rows">
                  <div className="worker-row">
                    <Network size={13} className="ico" />
                    <span className="v">{worker.host_name}</span>
                  </div>
                  <div className="worker-row">
                    <Bot size={13} className="ico" />
                    <span className="v mono">claude {worker.claude_version ?? "—"}</span>
                  </div>
                  <div className="worker-row">
                    <Clock size={13} className="ico" />
                    <span className="v">心跳 {fmtAgo(worker.last_seen_at)}</span>
                  </div>
                  <div className="worker-row">
                    <Activity size={13} className="ico" />
                    <span className="v">
                      在途 {worker.active_task_count ?? 0}/{worker.max_parallel}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

    </>
  );
}


export { WorkersView };
