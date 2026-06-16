// 任务详情页跨子视图共享的小件：Tab 定义 / 事件标签 / lifecycle 类型 / Section 卡片。
// 由 task-detail.tsx(主壳) 与各 task-detail-*.tsx 子视图复用，避免散落或循环依赖。
import type { ReactNode } from "react";
import { Activity, FileText, MessageSquare, ScrollText, Terminal } from "lucide-react";

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

export const EVENT_LABEL: Record<string, string> = {
  running: "开始执行",
  success: "执行完成",
  merged: "已合并",
  failed: "执行失败",
  waiting: "等待回复",
  scheduled_published: "定时到点·进入待处理"
};

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
