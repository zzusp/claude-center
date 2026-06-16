// Worker 展示原子:订阅类型标签 / 用量窗口格式化 / 用量条 / 工作态徽章。
// worker-detail.tsx 与 workers.tsx 共用,取代两份逐字节复制(避免口径漂移)。无状态,可在任意 client 组件用。
import { TONE_COLOR } from "./dashboard-shared";
import type { Tone } from "./shared";

// 订阅类型展示:套餐档位 vs API 计费。isPlanSubscription 决定是否展示用量。
export const SUBSCRIPTION_LABEL: Record<string, string> = {
  max: "套餐订阅 · Max",
  pro: "套餐订阅 · Pro",
  team: "套餐订阅 · Team",
  enterprise: "套餐订阅 · Enterprise",
  api: "API 计费",
  unknown: "未识别"
};

export function subscriptionLabel(type: string): string {
  return SUBSCRIPTION_LABEL[type] ?? type;
}

export function isPlanSubscription(type: string): boolean {
  return type !== "api" && type !== "unknown";
}

// 用量窗口重置倒计时:oauth/usage 给的是 resets_at 绝对时间,这里换算成剩余。
export function fmtResetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "已重置";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

// 套餐用量条:oauth/usage 只给利用率百分比(已用/总额度的比例)+ 重置时间,无绝对额度。
export function UsageBlock({ label, win }: { label: string; win: { utilization: number; resets_at: string } }) {
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

export function WorkingStateBadge({ state }: { state: string }) {
  const working = state === "working";
  return (
    <span className="badge" data-tone={working ? "success" : "pending"}>
      <span className="glyph">{working ? "▶" : "⏸"}</span>
      {working ? "工作中" : "空闲"}
    </span>
  );
}
