import type { ReactNode } from "react";

// 跨 dashboard / 任务详情页复用的展示原子与格式化工具。无状态、可在任意 client 组件中使用。

export type Tone =
  | "success"
  | "merged"
  | "running"
  | "pending"
  | "failed"
  | "cancelled"
  | "queued"
  | "waiting"
  | "draft"
  | "scheduled"
  | "review"
  | "rejected";

export const STATUS_META: Record<string, { glyph: string; label: string; tone: Tone }> = {
  draft: { glyph: "✎", label: "草稿", tone: "draft" },
  scheduled: { glyph: "⏰", label: "定时待发", tone: "scheduled" },
  pending: { glyph: "○", label: "待处理", tone: "pending" },
  claimed: { glyph: "◻", label: "已认领", tone: "queued" },
  running: { glyph: "◐", label: "执行中", tone: "running" },
  waiting: { glyph: "⏸", label: "等待回复", tone: "waiting" },
  success: { glyph: "◓", label: "待验收", tone: "review" },
  merged: { glyph: "✔", label: "已合并", tone: "merged" },
  accepted: { glyph: "✓", label: "已验收", tone: "success" },
  rejected: { glyph: "↺", label: "已打回", tone: "rejected" },
  failed: { glyph: "✕", label: "失败", tone: "failed" },
  cancelled: { glyph: "—", label: "已取消", tone: "cancelled" },
  online: { glyph: "●", label: "在线", tone: "success" },
  offline: { glyph: "—", label: "离线", tone: "cancelled" }
};

export function metaOf(status: string) {
  return STATUS_META[status] ?? { glyph: "·", label: status, tone: "cancelled" as Tone };
}

// 合并状态（work_branch → target_branch）：Console 定时检查的结果，独立于任务状态。
export const MERGE_STATUS_META: Record<string, { glyph: string; label: string; tone: Tone }> = {
  unknown: { glyph: "·", label: "未检查", tone: "cancelled" },
  unmerged: { glyph: "◌", label: "未合并", tone: "pending" },
  merged: { glyph: "✔", label: "已合并", tone: "merged" }
};

export async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `请求失败：${response.status}`);
  }
}

export function fmtTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

// 完整日期时间：YYYY-MM-dd HH:mm:ss（本地时区）。任务流列表「更新」列用，手动拼接保证分隔符固定。
export function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function StatusBadge({ status }: { status: string }) {
  const meta = metaOf(status);
  return (
    <span className="badge" data-tone={meta.tone}>
      <span className="glyph">{meta.glyph}</span>
      {meta.label}
    </span>
  );
}

export function MergeStatusBadge({ status }: { status: string }) {
  const meta = MERGE_STATUS_META[status] ?? { glyph: "·", label: status, tone: "cancelled" as Tone };
  return (
    <span className="badge" data-tone={meta.tone}>
      <span className="glyph">{meta.glyph}</span>
      {meta.label}
    </span>
  );
}

export function StatusDot({ status, pulse }: { status: string; pulse?: boolean }) {
  const meta = metaOf(status);
  return <span className={`dot${pulse ? " pulse" : ""}`} data-tone={status === "online" ? "online" : meta.tone} />;
}

export function KvRow({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className={`kv-v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}

export function Empty({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="empty">
      <span className="ico">{icon}</span>
      {text}
    </div>
  );
}

// 从 git 仓库 URL 提取 basename（去尾 ".git"）。用作子仓在 UI 上无名时的回退展示，
// 以及在 worker 端尚未派生本机相对路径时的占位检测兜底。
// 例：https://github.com/foo/widgets-lib.git → "widgets-lib"；git@github.com:foo/bar → "bar"。
export function basenameFromRepoUrl(repoUrl: string): string {
  if (!repoUrl) return "";
  const cleaned = repoUrl.replace(/[\/\s]+$/, "");
  const tail = cleaned.split(/[\/:]/).pop() ?? cleaned;
  return tail.replace(/\.git$/, "");
}

// 子仓 task_repos.relative_path 在 worker 派生前的占位前缀：`*-<projectRepoId>`。
// 见 docs/spec/project-repos-runtime-path.md。
export function isPendingSubRepoPath(rel: string | null | undefined): boolean {
  return !!rel && rel.startsWith("*-");
}
