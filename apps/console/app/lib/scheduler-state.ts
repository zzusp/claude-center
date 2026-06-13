// 调度器运行状态。instrumentation.ts（写）与 /api/overview（读）在 Next 下可能落在不同
// webpack bundle，模块级变量不保证同实例，故挂到 globalThis（与 instrumentation 的 started 标志
// 同一套 Symbol.for 约定）。纯内存态：单 Console 进程下成立；将来多实例时是 per-instance 视图。

export type SchedulerState = {
  startedAt: string | null;
  intervalMs: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastPromoted: number;
  totalPromoted: number;
  tickCount: number;
};

const KEY = Symbol.for("claude-center.scheduler.state");

function box(): { state: SchedulerState } {
  const g = globalThis as unknown as Record<symbol, { state: SchedulerState } | undefined>;
  let slot = g[KEY];
  if (!slot) {
    slot = {
      state: {
        startedAt: null,
        intervalMs: null,
        lastTickAt: null,
        lastError: null,
        lastPromoted: 0,
        totalPromoted: 0,
        tickCount: 0
      }
    };
    g[KEY] = slot;
  }
  return slot;
}

export function getSchedulerState(): SchedulerState {
  return { ...box().state };
}

export function recordSchedulerStart(intervalMs: number, atIso: string): void {
  const s = box().state;
  s.startedAt = atIso;
  s.intervalMs = intervalMs;
}

export function recordSchedulerTick(promoted: number, atIso: string, error: string | null): void {
  const s = box().state;
  s.lastTickAt = atIso;
  s.lastError = error;
  if (!error) {
    s.lastPromoted = promoted;
    s.totalPromoted += promoted;
    s.tickCount += 1;
  }
}

// 健康判定：已启动、最近一次 tick 无错、且发生在最近约 3 个周期内（容忍偶发抖动）。
export function isSchedulerHealthy(s: SchedulerState): boolean {
  if (!s.startedAt || !s.lastTickAt || !s.intervalMs) {
    return false;
  }
  if (s.lastError) {
    return false;
  }
  const sinceMs = Date.now() - new Date(s.lastTickAt).getTime();
  return sinceMs <= s.intervalMs * 3;
}
