"use client";

// 实时对话 / 任务详情「执行记录」顶部的元信息条：通道（SSE/DB 轮询） + 模型 + Worker
// (claude_version / 套餐) + 5h/7d 套餐用量 + 上下文 token + 本会话累计 in/out。
// Worker 信息由 /api/conversations/[id]、/api/tasks/[id] 顺路返回（见各自 route.ts），
// usage 与上下文 token 从 Claude Code session 的 .jsonl transcript 解析（assistant 消息
// 自带 message.usage = {input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}）。

import type { TaskModel, Worker } from "@claude-center/db";
import { Activity, Cpu, Database, Layers, Radio, RotateCw, Terminal, WifiOff } from "lucide-react";
import { useRelayStatus, type RelayStatus } from "../lib/use-relay";
import { extractBackgroundJobs, pendingBackgroundJobs } from "./transcript";
import { isPlanSubscription, subscriptionLabel } from "./worker-shared";

const MODEL_LABEL: Record<TaskModel, string> = {
  default: "默认（跟随 Worker）",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku"
};

// 通道徽章配色 / 文案 / 图标：connected=SSE 连接；其余降级到 DB 轮询语义。
// disabled 与 connecting 都以「数据库轮询」展示——前者是未配置中转、后者是首连未通；
// 用户视角都是「现在不是 SSE 在推」。reconnecting 单独显示「重连中」以解释偶发卡顿。
function channelOf(status: RelayStatus): { icon: typeof Radio; label: string; tone: string; title: string } {
  switch (status) {
    case "connected":
      return { icon: Radio, label: "SSE 连接", tone: "success", title: "通过中转 SSE 推送，亚秒级实时" };
    case "reconnecting":
      return { icon: RotateCw, label: "SSE 重连中", tone: "pending", title: "SSE 中转断开，正在重连；当前由数据库轮询兜底" };
    case "connecting":
      return { icon: Database, label: "数据库轮询", tone: "running", title: "SSE 中转首连中，当前由数据库轮询" };
    case "disabled":
    default:
      return { icon: Database, label: "数据库轮询", tone: "cancelled", title: "未启用 SSE 中转，纯数据库轮询" };
  }
}

export function RelayChannelBadge() {
  const status = useRelayStatus();
  const meta = channelOf(status);
  const Icon = meta.icon;
  return (
    <span className="sm-chip" data-tone={meta.tone} title={meta.title}>
      <Icon size={12} className="sm-ico" />
      {meta.label}
    </span>
  );
}

// 从 jsonl 解析出本会话的 token 统计 + 最近使用的真实模型。
// jsonl 每行是一个事件：assistant 行的 message.usage 是该轮 API 调用真实计费用量。
// - 上下文 token = 最后一条 assistant 的 input_tokens + cache_read + cache_creation
//   （= 该轮模型实际"看到"的 prompt 大小，对应 200k context window）
// - 本会话累计 in/out 把每轮加起来；cache 部分计 input 总数。
export type SessionUsage = {
  turns: number;
  contextTokens: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  lastModel: string | null;
};

type RawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export function extractSessionUsage(jsonl: string | null): SessionUsage | null {
  if (!jsonl) return null;
  let turns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let lastInput = 0;
  let lastCacheRead = 0;
  let lastCacheCreate = 0;
  let lastModel: string | null = null;

  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; message?: { model?: unknown; usage?: RawUsage } };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message) continue;
    const u = obj.message.usage;
    if (!u || typeof u !== "object") continue;
    const inp = num(u.input_tokens);
    const out = num(u.output_tokens);
    const cr = num(u.cache_read_input_tokens);
    const cc = num(u.cache_creation_input_tokens);
    if (inp === 0 && out === 0 && cr === 0 && cc === 0) continue;
    turns += 1;
    totalInput += inp;
    totalOutput += out;
    totalCacheRead += cr;
    totalCacheCreate += cc;
    lastInput = inp;
    lastCacheRead = cr;
    lastCacheCreate = cc;
    if (typeof obj.message.model === "string") lastModel = obj.message.model;
  }

  if (turns === 0) return null;
  return {
    turns,
    contextTokens: lastInput + lastCacheRead + lastCacheCreate,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheCreate,
    lastModel
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// 简洁数字格式化：< 1k 原值；< 1M 用 k；≥ 1M 用 M。token 量级展示用，统一一行 chip 里不溢出。
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

// 套餐窗口微型展示：百分比 + 12 段方块条；超 80% 红色提示。
// chip 里塞不下完整 UsageBlock（带轨条 + 倒计时），改为压缩到一个 chip 的样式。
function PlanWindowChip({ label, pct, title }: { label: string; pct: number; title: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const tone = clamped >= 90 ? "failed" : clamped >= 70 ? "pending" : "success";
  return (
    <span className="sm-chip sm-chip-usage" data-tone={tone} title={title}>
      <Activity size={12} className="sm-ico" />
      <span className="sm-usage-label">{label}</span>
      <span className="sm-usage-bar">
        <span className="sm-usage-fill" style={{ width: `${clamped}%` }} />
      </span>
      <span className="sm-usage-pct">{clamped.toFixed(0)}%</span>
    </span>
  );
}

function fmtResetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "已重置";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// 模型 chip：优先显示 jsonl 解析出的真实模型（'default' 时这是仅有的真实信息源）。
// 解析不出来时退到 plan-level 标签（默认/Opus/Sonnet/Haiku）。
function modelDisplay(planModel: TaskModel, lastModel: string | null): string {
  if (lastModel) {
    // claude-sonnet-4-5-20250929 → sonnet 4.5；claude-opus-4-1-20250805 → opus 4.1
    const m = lastModel.match(/claude-(opus|sonnet|haiku|fable)[-_]?(\d)[-_]?(\d+)?/i);
    if (m && m[1] && m[2]) {
      const family = m[1].toLowerCase();
      const major = m[2];
      const minor = m[3] ?? "";
      return minor ? `${family} ${major}.${minor}` : `${family} ${major}`;
    }
    return lastModel;
  }
  return MODEL_LABEL[planModel];
}

export type SessionMetaProps = {
  // 计划模型（'default' 表示跟随 worker 默认）。
  planModel: TaskModel;
  // 由对应详情 API 顺路返回的 worker 快照；未认领 / worker 已删时为 null。
  worker: Worker | null;
  // Claude Code session transcript（NDJSON）。null/空时不显示 token chip。
  jsonl: string | null;
  // 手机端折叠开关：false 时移动端 CSS 收起本条（data-open="0"）；省略/true 则常驻（桌面端忽略）。
  open?: boolean;
};

export function SessionMetaBar({ planModel, worker, jsonl, open }: SessionMetaProps) {
  const usage = extractSessionUsage(jsonl);
  const planUsage = worker?.usage;
  const isPlan = worker ? isPlanSubscription(worker.subscription_type) : false;
  // 「后台进程」chip：Bash run_in_background:true 派发但尚未收到 task-notification 完成回执的后台命令。
  // 主对话本轮 assistant 消息已落完时仍可能有后台任务挂着——它们完成后会通过 attachment.queued_command
  // 唤醒下一轮，本对话并未真正结束。chip 让用户一眼看到「还在等后台」。
  const bgJobs = jsonl ? extractBackgroundJobs(jsonl) : [];
  const bgPending = pendingBackgroundJobs(bgJobs);
  const bgTitle = bgPending.length
    ? `当前还有 ${bgPending.length} 个后台命令在跑（Claude 会在它们完成后再被唤醒；这意味着本对话/任务尚未真正结束）：\n` +
      bgPending.map((j) => `- ${j.description}`).slice(0, 8).join("\n") +
      (bgPending.length > 8 ? `\n...（共 ${bgPending.length} 个）` : "")
    : "";

  return (
    <div className="session-meta-bar" data-open={open === false ? "0" : "1"}>
      <RelayChannelBadge />
      {bgPending.length > 0 ? (
        <span className="sm-chip" data-tone="pending" title={bgTitle}>
          <Terminal size={12} className="sm-ico" />
          后台 {bgPending.length}
        </span>
      ) : null}

      <span className="sm-chip" title="本会话计划模型；下面尖括号内为 jsonl 解析的实际模型 ID">
        <Cpu size={12} className="sm-ico" />
        {modelDisplay(planModel, usage?.lastModel ?? null)}
      </span>

      {worker ? (
        <span
          className="sm-chip"
          title={`Worker：${worker.label || worker.name}\nclaude ${worker.claude_version ?? "—"}\n${subscriptionLabel(worker.subscription_type)}`}
        >
          <span className="sm-worker-name">{worker.label || worker.name}</span>
          <span className="sm-sep">·</span>
          <span className="sm-worker-ver">claude {worker.claude_version ?? "—"}</span>
          <span className="sm-sep">·</span>
          <span className="sm-worker-sub">{subscriptionLabel(worker.subscription_type)}</span>
        </span>
      ) : null}

      {isPlan && planUsage?.five_hour ? (
        <PlanWindowChip
          label="5h"
          pct={planUsage.five_hour.utilization}
          title={`5 小时窗口：已用 ${planUsage.five_hour.utilization.toFixed(0)}%，重置剩余 ${fmtResetIn(planUsage.five_hour.resets_at)}`}
        />
      ) : null}
      {isPlan && planUsage?.seven_day ? (
        <PlanWindowChip
          label="7d"
          pct={planUsage.seven_day.utilization}
          title={`7 天窗口：已用 ${planUsage.seven_day.utilization.toFixed(0)}%，重置剩余 ${fmtResetIn(planUsage.seven_day.resets_at)}`}
        />
      ) : null}
      {isPlan && planUsage?.error && !planUsage.five_hour && !planUsage.seven_day ? (
        <span className="sm-chip" data-tone="pending" title={`Worker 套餐用量采集失败：${planUsage.error}`}>
          <WifiOff size={12} className="sm-ico" />
          用量采集失败
        </span>
      ) : null}

      {usage ? (
        <>
          <span
            className="sm-chip"
            title={`本轮模型实际看到的 prompt 大小（最后一条 assistant.usage：input + cache_read + cache_creation）；对应 ~200k context window`}
          >
            <Layers size={12} className="sm-ico" />
            上下文 {fmtTokens(usage.contextTokens)}
          </span>
          <span
            className="sm-chip"
            title={`本会话累计：${usage.turns} 轮\ninput ${fmtTokens(usage.totalInput)}（cache 读 ${fmtTokens(usage.totalCacheRead)} / 写 ${fmtTokens(usage.totalCacheCreate)}）\noutput ${fmtTokens(usage.totalOutput)}`}
          >
            <span className="sm-usage-pair">
              {usage.turns} 轮 · in {fmtTokens(usage.totalInput)} / out {fmtTokens(usage.totalOutput)}
            </span>
          </span>
        </>
      ) : null}
    </div>
  );
}
