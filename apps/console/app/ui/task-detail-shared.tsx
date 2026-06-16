// 任务详情页跨子视图共享的小件：Tab 定义 / 事件标签 / lifecycle 类型 / Section 卡片。
// 由 task-detail.tsx(主壳) 与各 task-detail-*.tsx 子视图复用，避免散落或循环依赖。
import type { ReactNode } from "react";
import { Activity, FileText, MessageSquare, ScrollText, Terminal } from "lucide-react";
import type { Tone } from "./shared";

export type DetailTabKey = "overview" | "timeline" | "chat" | "execution" | "logs";

// lifecycle 阶段：主壳计算，OverviewTab / TimelineTab 复用展示。
export type LifecycleStep = { label: string; time: string | null; state: "done" | "active" | "idle" };

export const DETAIL_TABS: { key: DetailTabKey; label: string; icon: ReactNode }[] = [
  { key: "overview", label: "概览", icon: <FileText size={14} /> },
  { key: "timeline", label: "时间线", icon: <Activity size={14} /> },
  { key: "chat", label: "对话", icon: <MessageSquare size={14} /> },
  { key: "execution", label: "Claude Code 执行", icon: <Terminal size={14} /> },
  { key: "logs", label: "日志", icon: <ScrollText size={14} /> }
];

// 细颗粒度时间线:task_events 全量事件类型 → 中文标签 + 配色(复用 StatusBadge 的 Tone 调色板)。
// 覆盖生命周期主干 + Worker 执行编排子步骤(见 docs/spec/task-event-timeline-retry.md §3.2)。
// 未登记的 event_type 回退为原串 + pending 配色,不至于裸奔。
export type EventMeta = { label: string; tone: Tone };

export const EVENT_META: Record<string, EventMeta> = {
  created: { label: "任务创建", tone: "draft" },
  published: { label: "发布·进入待处理", tone: "pending" },
  scheduled_published: { label: "定时到点·进入待处理", tone: "scheduled" },
  claimed: { label: "已认领", tone: "queued" },
  worktree_prepared: { label: "工作树就绪", tone: "running" },
  running: { label: "开始执行", tone: "running" },
  resumed: { label: "用户回复·续接执行", tone: "running" },
  rerun_started: { label: "打回·续接重跑", tone: "running" },
  retry_started: { label: "失败·续接重试", tone: "running" },
  claude_turn_finished: { label: "本轮执行结束", tone: "pending" },
  waiting: { label: "等待用户回复", tone: "waiting" },
  auto_reply: { label: "自动回复·无人值守", tone: "waiting" },
  auto_reply_blocked: { label: "自动回复兜底失败", tone: "failed" },
  committed: { label: "已提交改动", tone: "running" },
  pushed: { label: "已推送分支", tone: "running" },
  pr_created: { label: "已创建 PR", tone: "review" },
  auto_merged: { label: "PR 自动合并", tone: "merged" },
  auto_merge_failed: { label: "PR 自动合并失败", tone: "failed" },
  success: { label: "执行完成·待验收", tone: "review" },
  failed: { label: "执行失败", tone: "failed" },
  cancel_requested: { label: "请求取消", tone: "cancelled" },
  cancelled: { label: "已取消", tone: "cancelled" },
  retry_requested: { label: "已请求续接重试", tone: "pending" },
  accepted: { label: "人工验收通过", tone: "success" },
  rejected: { label: "人工验收打回", tone: "rejected" },
  merge_accepted: { label: "检测合并·自动验收", tone: "success" },
  merged: { label: "已合并落地", tone: "merged" },
  cleanup_retry: { label: "合并清理重试", tone: "pending" }
};

export function eventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? { label: type, tone: "pending" };
}

// 「执行起点」事件:每个都开启一轮新的执行尝试(attempt),时间线据此把事件切成可折叠的轮次。
export const ROUND_START_EVENTS = new Set(["running", "resumed", "rerun_started", "retry_started"]);

// 失败类事件:任务当前停在 failed/cancelled 时,这些节点旁渲染「续接重试」入口。
export const FAILURE_EVENTS = new Set(["failed", "cancelled", "auto_reply_blocked"]);

// 指向「Claude Code 执行」Tab(transcript)的事件:逐轮对话/工具调用富展示在那里,时间线只给跳转。
export const EXECUTION_LINK_EVENTS = new Set([
  "running",
  "resumed",
  "rerun_started",
  "retry_started",
  "claude_turn_finished"
]);

export function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card detail-section">
      <div className="section-head">
        <span className="section-ico">{icon}</span>
        <h3 className="section-title">{title}</h3>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}
