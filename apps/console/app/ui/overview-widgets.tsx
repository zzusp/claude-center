"use client";

import { useEffect, useRef, useState } from "react";
import { Clock, Database, RadioTower } from "lucide-react";
import { KvRow, type Tone } from "./shared";
import { TONE_COLOR, fmtAgo, syncAgo, type Health, type MergeCheckHealth, type WorkerSweepHealth } from "./dashboard-shared";
import { useRelayStatus, type RelayStatus as RelayConnState } from "../lib/use-relay";
import { useCountUp } from "../lib/use-count-up";

// 总览页展示型小部件：同步/中转状态、运行健康卡、统计卡、迷你折线、状态环。
// 从 overview.tsx 抽出（无业务状态，纯按 props 渲染）。

// SSE 中转连接状态 → 展示元数据（label/tone/是否脉冲）。tone 复用 .dot[data-tone] 配色。
const RELAY_META: Record<RelayConnState, { label: string; tone: string; live: boolean }> = {
  connected: { label: "已连通", tone: "online", live: true },
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
    <span className="sync" data-live={status === "connected" ? "on" : "off"} title="SSE 连接状态">
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
  const sweep = sched?.workerSweep;
  const merge = sched?.mergeCheck;
  // 整卡 ok：仅「已启动」的段参与判定，未启动段视为 N/A 不让整卡翻红。
  // 这样兼容两种过渡态：(a) dev 下 Fast Refresh 不重跑 instrumentation 时旧进程没写新段 state；
  // (b) prod 滚动升级时新前端短暂连到旧后端实例。判定标准：promote 用 startedAt、sweep 用 lastTickAt、
  // merge 用 startedAt——为各段「曾经活过」的真实信号。
  const promoteStarted = Boolean(sched?.startedAt);
  const sweepStarted = Boolean(sweep?.lastTickAt);
  const mergeStarted = Boolean(merge?.startedAt);
  const promoteOk = !promoteStarted || (sched?.ok ?? false);
  const sweepOk = !sweepStarted || (sweep?.ok ?? false);
  const mergeOk = !mergeStarted || (merge?.ok ?? false);
  const schedulerEverStarted = promoteStarted || sweepStarted || mergeStarted;
  const schedulerAllOk = promoteOk && sweepOk && mergeOk && schedulerEverStarted;
  const schedulerLabel = schedulerAllOk ? "运行中" : schedulerEverStarted ? "异常" : "未启动";
  const relay = useRelayStatus();
  const relayMeta = RELAY_META[relay];
  // SSE 中转摘要(admin only,API 自带 403 守卫):enabled=false 或 403 时 summary=null,几行 SSE KV 自动不渲染。
  const summary = useRelaySummary();

  const realtimeRows: { k: string; v: React.ReactNode; mono?: boolean }[] = [
    {
      k: "连接状态",
      v: (
        <span className="relay-inline">
          <span className={`dot${relayMeta.live ? " pulse" : ""}`} data-tone={relayMeta.tone} />
          {relayMeta.label}
        </span>
      )
    }
  ];
  if (summary && summary.kind === "ok") {
    realtimeRows.push(
      {
        k: "在线连接",
        v: (
          <span className="relay-inline">
            <b style={{ color: "var(--text-1)", fontVariantNumeric: "tabular-nums" }}>{summary.clients}</b>
            <span style={{ color: "var(--text-4)", fontSize: 11.5 }}>
              · {summary.workers} worker · {summary.tickets} 浏览器
            </span>
          </span>
        )
      },
      {
        k: "实时事件",
        v: (
          <span className="relay-inline" style={{ fontVariantNumeric: "tabular-nums" }}>
            <RelayEventsValue eventSeq={summary.eventSeq} rate={summary.rate} />
          </span>
        )
      },
      {
        k: "占用频道",
        v: (
          <span className="relay-inline" style={{ fontVariantNumeric: "tabular-nums" }}>
            <RelayChannelsValue count={summary.channels} />
          </span>
        )
      }
    );
  } else if (summary && summary.kind === "error") {
    realtimeRows.push({ k: "中转明细", v: <span style={{ color: "var(--failed)" }}>{summary.error}</span> });
  }

  return (
    <section className="health-section">
      <div className="section-head">
        <h2 className="section-title">系统运行状态</h2>
        <span className="section-sub">数据库 · 调度器 · SSE 连接</span>
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
          ok={schedulerAllOk}
          okLabel={schedulerLabel}
        >
          <SchedulerCardBody sched={sched ?? null} sweep={sweep ?? null} merge={merge ?? null} />
        </HealthCard>
        <HealthCard
          icon={<RadioTower size={16} />}
          title="SSE 连接"
          ok={synced}
          okLabel={synced ? (lastSyncAt ? `同步中 · ${fmtAgo(lastSyncAt)}` : "同步中") : "已断开"}
          rows={realtimeRows}
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
  rows,
  children
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean;
  okLabel: string;
  rows?: { k: string; v: React.ReactNode; mono?: boolean }[];
  children?: React.ReactNode;
}) {
  // 健康时绿点呼吸（cc-breathe + cc-ring 复用），异常时红点静态——避免红色长时间闪烁喧宾夺主。
  // children 优先于 rows：调度器卡用 children 渲染 3 段子状态，其他卡仍传 rows。
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">
          <span className="ico">{icon}</span>
          {title}
        </h2>
        <span className="badge" data-tone={ok ? "success" : "failed"}>
          <span className={`dot${ok ? " pulse" : ""}`} data-tone={ok ? "online" : "failed"} />
          {okLabel}
        </span>
      </div>
      <div className="card-body health-body">
        {children ?? rows?.map((row) => <KvRow key={row.k} k={row.k} v={row.v} mono={row.mono} />)}
      </div>
    </section>
  );
}

// 定时调度器卡片专用 body：3 行紧凑布局（每段一行 = ● 标题 + 周期 + 上次时间），
// 异常时在该段下方多一行 lastError；正常路径只 3 行，高度与同行其他健康卡持平。
function SchedulerCardBody({
  sched,
  sweep,
  merge
}: {
  sched: Health["scheduler"] | null;
  sweep: WorkerSweepHealth | null;
  merge: MergeCheckHealth | null;
}) {
  const promoteInterval = sched?.intervalMs ? `每 ${Math.round(sched.intervalMs / 1000)}s` : null;
  const mergeInterval = merge?.intervalMs ? `每 ${Math.round(merge.intervalMs / 1000)}s` : null;
  return (
    <>
      <SchedulerRow
        title="定时任务检查"
        meta={promoteInterval}
        value={sched?.lastTickAt ? fmtAgo(sched.lastTickAt) : "—"}
        ok={sched?.ok ?? false}
        started={Boolean(sched?.startedAt)}
        error={sched?.lastError ?? null}
      />
      <SchedulerRow
        title="PR 合并检查"
        meta={mergeInterval}
        value={merge?.lastTickAt ? fmtAgo(merge.lastTickAt) : "—"}
        ok={merge?.ok ?? false}
        started={Boolean(merge?.startedAt)}
        error={merge?.lastError ?? null}
      />
      <SchedulerRow
        title="Worker 离线扫描"
        meta={promoteInterval}
        value={sweep?.lastTickAt ? fmtAgo(sweep.lastTickAt) : "—"}
        ok={sweep?.ok ?? false}
        started={Boolean(sweep?.lastTickAt)}
        error={sweep?.lastError ?? null}
      />
    </>
  );
}

function SchedulerRow({
  title,
  meta,
  value,
  ok,
  started,
  error
}: {
  title: string;
  meta: string | null;
  value: string;
  ok: boolean;
  started: boolean;
  error: string | null;
}) {
  // 未启动时灰点不脉动；启动+健康绿色脉动；启动+异常红色静态。
  const tone = !started ? "offline" : ok ? "online" : "failed";
  return (
    <div className="sched-row-wrap">
      <div className="sched-row">
        <span className={`dot${started && ok ? " pulse" : ""}`} data-tone={tone} />
        <span className="sched-row-title">{title}</span>
        {meta ? <span className="sched-row-meta">{meta}</span> : null}
        <span className="sched-row-value">{value}</span>
      </div>
      {error ? <div className="sched-row-error">{error}</div> : null}
    </div>
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
  const display = useCountUp(value);
  // 数值变化时切换 pulseKey，触发 .stat-pulse 重建以再次跑一次性 cc-card-pulse 描边。
  // 首次挂载不算"刷新"，跳过。
  const [pulseKey, setPulseKey] = useState(0);
  const firstRef = useRef(true);
  const prevValueRef = useRef(value);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      prevValueRef.current = value;
      return;
    }
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      setPulseKey((n) => n + 1);
    }
  }, [value]);
  return (
    <article className="stat-card">
      {pulseKey > 0 ? (
        <span
          key={pulseKey}
          className="stat-pulse"
          style={{ ["--pulse-color" as never]: TONE_COLOR[tone] } as React.CSSProperties}
        />
      ) : null}
      <div className="stat-head">
        <span className="ico" style={{ color: TONE_COLOR[tone] }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="stat-value">
        {display}
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
      <circle className="spark-tip" cx={last[0]} cy={last[1]} r={2.5} fill={color} />
    </svg>
  );
}

export function Donut({
  segments,
  total,
  centerLabel = "任务"
}: {
  segments: { label: string; tone: Tone; value: number; status: string }[];
  total: number;
  centerLabel?: string;
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
          <div className="l">{centerLabel}</div>
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

// 实时事件 KV 值：累计 CountUp + 每秒速率（rate 仅在第二次采样后才非 null）。
function RelayEventsValue({ eventSeq, rate }: { eventSeq: number; rate: number | null }) {
  const events = useCountUp(eventSeq);
  const rateLabel = rate == null ? null : rate >= 10 ? rate.toFixed(0) : rate.toFixed(1);
  return (
    <>
      <b style={{ color: "var(--text-1)" }}>{events.toLocaleString()}</b>
      {rateLabel ? (
        <span style={{ color: "var(--text-4)", fontSize: 11.5 }}>· {rateLabel}/s</span>
      ) : null}
    </>
  );
}

function RelayChannelsValue({ count }: { count: number }) {
  const channels = useCountUp(count);
  return <b style={{ color: "var(--text-1)" }}>{channels}</b>;
}

// SSE 中转摘要（精简版）：并入 RuntimeHealth 的"SSE 连接"卡片。
// - API 返回 403（非 admin）/ { enabled:false } → 返回 null，SSE 行不渲染（普通用户无感）。
// - 错误 → kind:"error"，上层显示一条说明（便于发现 relay 不健康）。
// - OK → kind:"ok"，上层渲染"在线连接 / 实时事件 / 占用频道"三行。
type RelaySummaryState =
  | {
      kind: "ok";
      clients: number;
      workers: number;
      tickets: number;
      channels: number;
      eventSeq: number;
      rate: number | null;
    }
  | { kind: "error"; error: string };

const RELAY_SUMMARY_POLL_MS = 30_000;

type RelayConnectionShape = { source: "worker" | "ticket"; channels: string[] };

function useRelaySummary(): RelaySummaryState | null {
  const [state, setState] = useState<RelaySummaryState | null>(null);
  const prevRef = useRef<{ seq: number; ts: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/relay/connections", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 403) {
          setState(null);
          return;
        }
        const raw = (await res.json()) as
          | { enabled: false }
          | { enabled: true; error?: string; eventSeq?: number; clients?: RelayConnectionShape[] };
        if (cancelled) return;
        if (!raw.enabled) {
          setState(null);
          return;
        }
        if (typeof raw.error === "string") {
          setState({ kind: "error", error: raw.error });
          return;
        }
        const seq = raw.eventSeq ?? 0;
        const tsNow = Date.now();
        const prev = prevRef.current;
        const rate =
          prev && tsNow > prev.ts && seq >= prev.seq ? (seq - prev.seq) / ((tsNow - prev.ts) / 1000) : null;
        prevRef.current = { seq, ts: tsNow };
        const clients = raw.clients ?? [];
        const channelSet = new Set<string>();
        let workers = 0;
        let tickets = 0;
        for (const c of clients) {
          for (const ch of c.channels) channelSet.add(ch);
          if (c.source === "worker") workers += 1;
          else tickets += 1;
        }
        setState({
          kind: "ok",
          clients: clients.length,
          workers,
          tickets,
          channels: channelSet.size,
          eventSeq: seq,
          rate
        });
      } catch {
        // 网络瞬抖：保留上一帧数据，下一轮再试。
      }
    }
    load();
    const timer = window.setInterval(load, RELAY_SUMMARY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return state;
}

