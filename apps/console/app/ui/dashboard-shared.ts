import type { Permission, Role, Task, Worker } from "@claude-center/db";
import type { Tone } from "./shared";

type WorkerSweepHealth = {
  lastTickAt: string | null;
  lastError: string | null;
  lastOfflined: number;
  totalOfflined: number;
  tickCount: number;
  ok: boolean;
};

type MergeCheckHealth = {
  startedAt: string | null;
  intervalMs: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastChecked: string | null;
  lastMergedTaskId: string | null;
  totalChecked: number;
  totalMerged: number;
  tickCount: number;
  ok: boolean;
};

type Health = {
  db: { ok: boolean; latencyMs: number | null; pool: { total: number; idle: number; waiting: number; max: number } };
  scheduler: {
    startedAt: string | null;
    intervalMs: number | null;
    lastTickAt: string | null;
    lastError: string | null;
    lastPromoted: number;
    totalPromoted: number;
    tickCount: number;
    scheduledPending: number;
    ok: boolean;
    workerSweep: WorkerSweepHealth;
    mergeCheck: MergeCheckHealth;
  };
};

// 总览页数据（/api/dashboard）：summary 卡片 + worker/任务流 + 运行健康。
// projects / commands 已随菜单页拆分移除（各页自取所需）。
// dailyNewTasks / dailyCompletedTasks / dailyMergedTasks：后端按 RBAC 算的最近 7 天每日数（长度 7，缺失补 0），
// 下标 6 = 今天，分别作为「今日新任务 / 今日完成 / 今日合并」三张卡的 sparkline 数据源。
type Overview = {
  workers: Worker[];
  tasks: Task[];
  summary: {
    onlineWorkers: number;
    todayNewTasks: number;
    todayCompletedTasks: number;
    todayMergedTasks: number;
  };
  dailyNewTasks: number[];
  dailyCompletedTasks: number[];
  dailyMergedTasks: number[];
  health: Health | null;
};

type ViewKey = "dashboard" | "tasks" | "chat" | "workers" | "projects" | "users";

// 当前登录用户（由服务端 page.tsx 注入）。permissions 决定 UI 显隐。
type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
};

// 角色标签与可选项（客户端本地副本，避免把 @claude-center/db 的运行时代码打进前端包）。
const ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  publisher: "发布执行",
  commenter: "任务对话",
  viewer: "只读"
};
const ROLE_OPTIONS: Role[] = ["viewer", "commenter", "publisher", "admin"];

const emptyOverview: Overview = {
  workers: [],
  tasks: [],
  summary: { onlineWorkers: 0, todayNewTasks: 0, todayCompletedTasks: 0, todayMergedTasks: 0 },
  dailyNewTasks: [],
  dailyCompletedTasks: [],
  dailyMergedTasks: [],
  health: null
};

const SPARK_CAP = 24;

const TONE_COLOR: Record<Tone, string> = {
  success: "var(--success)",
  merged: "var(--merged)",
  running: "var(--running)",
  pending: "var(--pending)",
  failed: "var(--failed)",
  cancelled: "var(--cancelled)",
  queued: "var(--queued)",
  waiting: "var(--waiting)",
  draft: "var(--draft)",
  scheduled: "var(--scheduled)"
};

function fmtAgo(value: string | null): string {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function syncAgo(value: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (s < 2) return "刚刚";
  if (s < 60) return `${s} 秒前`;
  return `${Math.floor(s / 60)} 分钟前`;
}

export type { Health, MergeCheckHealth, Overview, ViewKey, WorkerSweepHealth, CurrentUser };
export { ROLE_LABEL, ROLE_OPTIONS, emptyOverview, SPARK_CAP, TONE_COLOR, fmtAgo, syncAgo };
