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
  overview,
  canCommand,
  onChanged
}: {
  overview: Overview;
  canCommand: boolean;
  onChanged: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState("");

  // 抽屉读 live 数据：存 id 而非快照，轮询刷新后用量/工作态自动更新。
  const selected = selectedId ? overview.workers.find((worker) => worker.id === selectedId) ?? null : null;

  function activeTasksOf(workerId: string) {
    return overview.tasks.filter(
      (task) => task.claimed_by === workerId && (task.status === "running" || task.status === "claimed")
    );
  }

  async function toggleWorking(worker: Worker) {
    const next = worker.working_state === "working" ? "idle" : "working";
    setToggling(true);
    setToggleError("");
    try {
      await postJson(`/api/workers/${worker.id}/working-state`, { state: next });
      await onChanged();
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : "切换失败");
    } finally {
      setToggling(false);
    }
  }

  return (
    <>
      <div className="section-head">
        <div>
          <h2 className="section-title">执行机群</h2>
          <span className="section-sub">
            {overview.summary.onlineWorkers}/{overview.workers.length} 在线 · 心跳 60s 超时判离线 · 在线≠接任务
          </span>
        </div>
      </div>

      {overview.workers.length === 0 ? (
        <section className="card">
          <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
        </section>
      ) : (
        <div className="worker-grid">
          {overview.workers.map((worker) => {
            const active = activeTasksOf(worker.id);
            return (
              <article
                className="worker-card"
                key={worker.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(worker.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedId(worker.id);
                  }
                }}
              >
                <div className="worker-top">
                  <StatusDot status={worker.status} pulse={worker.status === "online"} />
                  <span className="worker-name">{worker.name}</span>
                  <StatusBadge status={worker.status} />
                  <WorkingStateBadge state={worker.working_state} />
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
                      在途 {worker.active_task_count ?? active.length}/{worker.max_parallel}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Drawer open={selected !== null} title={selected?.name ?? ""} onClose={() => setSelectedId(null)}>
        {selected ? (
          <>
            <div className="kv">
              <KvRow k="在线状态" v={<StatusBadge status={selected.status} />} />
              <KvRow
                k="工作状态"
                v={
                  <span className="remote-toggle-row">
                    <WorkingStateBadge state={selected.working_state} />
                    {canCommand ? (
                      selected.allow_remote_control ? (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={toggling}
                          onClick={() => toggleWorking(selected)}
                        >
                          {selected.working_state === "working" ? "切到空闲" : "切到工作"}
                        </button>
                      ) : (
                        <span className="remote-hint">该 Worker 未开启远程开关</span>
                      )
                    ) : null}
                  </span>
                }
              />
              {toggleError ? <KvRow k="" v={<span className="remote-hint">{toggleError}</span>} /> : null}
              <KvRow k="主机" v={selected.host_name} mono />
              <KvRow k="Worker 版本" v={`v${selected.app_version}`} mono />
              <KvRow k="Claude Code 版本" v={selected.claude_version ?? "—"} mono />
              <KvRow k="订阅类型" v={subscriptionLabel(selected.subscription_type)} />
            </div>

            {isPlanSubscription(selected.subscription_type) &&
            (selected.usage.five_hour || selected.usage.seven_day) ? (
              <>
                <div className="detail-subhead">套餐用量</div>
                {selected.usage.five_hour ? (
                  <UsageBlock label="5 小时窗口" win={selected.usage.five_hour} />
                ) : null}
                {selected.usage.seven_day ? (
                  <UsageBlock label="7 天窗口" win={selected.usage.seven_day} />
                ) : null}
              </>
            ) : null}

            <div className="detail-subhead">
              并行处理（{selected.active_task_count ?? activeTasksOf(selected.id).length}/{selected.max_parallel}）
            </div>
            {activeTasksOf(selected.id).length === 0 ? (
              <div className="remote-hint">当前空闲，无在途任务</div>
            ) : (
              <div className="parallel-list">
                {activeTasksOf(selected.id).map((task) => (
                  <div className="parallel-item" key={task.id}>
                    <span className="t">{task.title}</span>
                    <StatusBadge status={task.status} />
                  </div>
                ))}
              </div>
            )}

            <div className="detail-subhead">运行信息</div>
            <div className="kv">
              <KvRow k="并行上限" v={String(selected.max_parallel)} />
              <KvRow
                k="最后心跳"
                v={`${fmtDateTime(selected.last_seen_at)}（${fmtAgo(selected.last_seen_at)}）`}
              />
              <KvRow k="创建于" v={fmtDateTime(selected.created_at)} />
              <KvRow k="更新于" v={fmtDateTime(selected.updated_at)} />
              {Object.keys(selected.capabilities).length > 0 ? (
                <KvRow k="能力" v={JSON.stringify(selected.capabilities)} mono />
              ) : null}
              {Object.keys(selected.metadata).length > 0 ? (
                <KvRow k="元数据" v={JSON.stringify(selected.metadata)} mono />
              ) : null}
              <KvRow k="Worker ID" v={selected.id} mono />
            </div>
          </>
        ) : null}
      </Drawer>
    </>
  );
}


export { WorkersView };
