"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock, Database, Network, RadioTower } from "lucide-react";
import { Empty, KvRow, type Tone } from "./shared";
import { TONE_COLOR, fmtAgo, syncAgo, type Health } from "./dashboard-shared";
import { POLL_INTERVAL_MS } from "../lib/use-polling";
import { useRelayStatus, type RelayStatus as RelayConnState } from "../lib/use-relay";

// 总览页展示型小部件：同步/中转状态、运行健康卡、统计卡、迷你折线、状态环。
// 从 overview.tsx 抽出（无业务状态，纯按 props 渲染）。

// SSE 中转连接状态 → 展示元数据（label/tone/是否脉冲）。tone 复用 .dot[data-tone] 配色。
const RELAY_META: Record<RelayConnState, { label: string; tone: string; live: boolean }> = {
  connected: { label: "实时通道已连通", tone: "online", live: true },
  connecting: { label: "连接中", tone: "running", live: true },
  reconnecting: { label: "重连中", tone: "pending", live: true },
  disabled: { label: "未启用（纯轮询）", tone: "offline", live: false }
};

export function SyncStatus({
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

// SSE 中转连接状态指示器（顶栏，全站每页可见）：与 SyncStatus 并列，区分「DB 轮询」与「SSE 快线」两条线。
export function RelayStatus() {
  const status = useRelayStatus();
  const meta = RELAY_META[status];
  return (
    <span className="sync" data-live={status === "connected" ? "on" : "off"} title="SSE 实时中转连接状态">
      <span className={`dot${meta.live ? " pulse" : ""}`} data-tone={meta.tone} />
      <span className="sync-text">SSE {meta.label}</span>
    </span>
  );
}

export function RuntimeHealth({
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
  const relay = useRelayStatus();
  const relayMeta = RELAY_META[relay];

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
            { k: "上次同步", v: lastSyncAt ? fmtAgo(lastSyncAt) : "—" },
            {
              k: "SSE 中转",
              v: (
                <span className="relay-inline">
                  <span className={`dot${relayMeta.live ? " pulse" : ""}`} data-tone={relayMeta.tone} />
                  {relayMeta.label}
                </span>
              )
            }
          ]}
        />
      </div>
    </section>
  );
}

export function HealthCard({
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

export function StatCard({
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

export function Sparkline({ data, tone }: { data: number[]; tone: Tone }) {
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

export function Donut({
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

// SSE 中转连接明细卡片（admin only）：30s 轮询 /api/relay/connections。
//   - 非 admin → API 返回 403，本卡不渲染（避免给非管理员暴露后端 channel 命名）
//   - relay 未配 URL/PUBLISH_TOKEN → API 返回 { enabled:false }，不渲染
//   - 其它错误 → 渲染卡片但 body 显示报错（便于发现 relay 不健康）
const RELAY_CONN_POLL_MS = 30_000;

type RelayConnection = {
  id: number;
  source: "worker" | "ticket";
  channels: string[];
  connectedAt: number;
  lastEventId?: string;
};

type RelayConnectionsState =
  | { kind: "error"; error: string }
  | { kind: "ok"; uptimeMs: number; eventSeq: number; clients: RelayConnection[] };

// 持续时长（ms）→ "12s" / "3m 20s" / "1h 14m"，KV / 表格列共用。
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const rest = sec % 60;
    return rest ? `${min}m ${rest}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const restMin = min % 60;
  return restMin ? `${hr}h ${restMin}m` : `${hr}h`;
}

export function RelayConnectionsCard() {
  const [data, setData] = useState<RelayConnectionsState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/relay/connections", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 403) {
          setHidden(true);
          return;
        }
        const raw = (await res.json()) as
          | { enabled: false }
          | { enabled: true; error?: string; uptimeMs?: number; eventSeq?: number; clients?: RelayConnection[] };
        if (cancelled) return;
        if (!raw.enabled) {
          setHidden(true);
          return;
        }
        if (typeof raw.error === "string") {
          setData({ kind: "error", error: raw.error });
        } else {
          setData({
            kind: "ok",
            uptimeMs: raw.uptimeMs ?? 0,
            eventSeq: raw.eventSeq ?? 0,
            clients: raw.clients ?? []
          });
        }
        setNow(Date.now());
      } catch {
        // 网络错误：保留上一帧数据，下一轮再试。
      }
    }
    load();
    const timer = window.setInterval(load, RELAY_CONN_POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(tick);
    };
  }, []);

  if (hidden) {
    return null;
  }
  if (!data) {
    return null;
  }
  if (data.kind === "error") {
    return (
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">
            <Network size={16} className="ico" />
            SSE 中转连接
            <span className="badge" data-tone="review" style={{ marginLeft: 8 }}>
              admin
            </span>
          </h2>
        </div>
        <div className="card-body">
          <div className="error-box">{data.error}</div>
        </div>
      </section>
    );
  }

  const { uptimeMs, eventSeq, clients } = data;
  const channelSet = new Set<string>();
  let workerCount = 0;
  let ticketCount = 0;
  for (const client of clients) {
    for (const ch of client.channels) channelSet.add(ch);
    if (client.source === "worker") workerCount += 1;
    else ticketCount += 1;
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <Network size={16} className="ico" />
          SSE 中转连接
          <span className="badge" data-tone="role-admin" style={{ marginLeft: 8 }}>
            admin
          </span>
        </h2>
        <span className="card-tools">每 {Math.round(RELAY_CONN_POLL_MS / 1000)}s 刷新</span>
      </div>
      <div className="card-body relay-conn-body">
        <div className="relay-conn-summary">
          <SummaryStat label="运行时长" value={fmtDuration(uptimeMs)} />
          <SummaryStat
            label="在线连接"
            value={`${clients.length}`}
            sub={`${workerCount} worker · ${ticketCount} 浏览器`}
          />
          <SummaryStat label="占用频道" value={`${channelSet.size}`} />
          <SummaryStat label="累计事件" value={`${eventSeq}`} />
        </div>
        {clients.length === 0 ? (
          <Empty icon={<RadioTower size={28} />} text="当前无活动连接" />
        ) : (
          <div className="table-wrap">
            <table className="table relay-conn-table">
              <thead>
                <tr>
                  <th>来源</th>
                  <th>客户端 #</th>
                  <th>已连时长</th>
                  <th>频道</th>
                  <th className="t-right">最近事件 ID</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <RelayConnRow key={client.id} client={client} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="relay-conn-stat">
      <div className="relay-conn-stat-label">{label}</div>
      <div className="relay-conn-stat-value">{value}</div>
      {sub ? <div className="relay-conn-stat-sub">{sub}</div> : null}
    </div>
  );
}

function RelayConnRow({ client, now }: { client: RelayConnection; now: number }) {
  const sourceLabel = client.source === "worker" ? "Worker" : "浏览器";
  const sourceTone = client.source === "worker" ? "success" : "running";
  const sourceDotTone = client.source === "worker" ? "online" : "running";
  return (
    <tr>
      <td>
        <span className="badge" data-tone={sourceTone}>
          <span className="dot" data-tone={sourceDotTone} />
          {sourceLabel}
        </span>
      </td>
      <td className="mono">#{client.id}</td>
      <td className="mono">{fmtDuration(now - client.connectedAt)}</td>
      <td>
        <div className="relay-conn-channels">
          {client.channels.map((channel) => (
            <span key={channel} className="chip mono" title={channel}>
              {channel}
            </span>
          ))}
        </div>
      </td>
      <td className="t-right mono">{client.lastEventId ?? "—"}</td>
    </tr>
  );
}
