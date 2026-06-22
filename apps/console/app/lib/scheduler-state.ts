// 调度器运行状态。instrumentation.ts（写）与 /api/dashboard（读）在 Next 下可能落在不同
// webpack bundle，模块级变量不保证同实例，故挂到 globalThis（与 instrumentation 的 started 标志
// 同一套 Symbol.for 约定）。纯内存态：单 Console 进程下成立；将来多实例时是 per-instance 视图。
//
// 三段独立状态对应 instrumentation-node.ts 里的三件事：
//   1) promote     —— 定时任务 scheduled→pending（独立循环 + 独立间隔）
//   2) workerSweep —— 心跳超时的 worker 翻 offline（与 promote 同 tick，复用 promote 间隔）
//   3) mergeCheck  —— success+PR 的任务远程探测合并状态（独立循环 + 独立间隔）

export type SchedulerState = {
  startedAt: string | null;
  intervalMs: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastPromoted: number;
  totalPromoted: number;
  tickCount: number;
};

export type WorkerSweepState = {
  lastTickAt: string | null;
  lastError: string | null;
  lastOfflined: number;
  totalOfflined: number;
  tickCount: number;
};

export type MergeCheckState = {
  startedAt: string | null;
  intervalMs: number | null;
  lastTickAt: string | null;
  lastError: string | null;
  lastChecked: string | null;
  lastMergedTaskId: string | null;
  totalChecked: number;
  totalMerged: number;
  tickCount: number;
};

const KEY = Symbol.for("claude-center.scheduler.state");
const SWEEP_KEY = Symbol.for("claude-center.worker-sweep.state");
const MERGE_KEY = Symbol.for("claude-center.merge-check.state");

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

function sweepBox(): { state: WorkerSweepState } {
  const g = globalThis as unknown as Record<symbol, { state: WorkerSweepState } | undefined>;
  let slot = g[SWEEP_KEY];
  if (!slot) {
    slot = {
      state: { lastTickAt: null, lastError: null, lastOfflined: 0, totalOfflined: 0, tickCount: 0 }
    };
    g[SWEEP_KEY] = slot;
  }
  return slot;
}

function mergeBox(): { state: MergeCheckState } {
  const g = globalThis as unknown as Record<symbol, { state: MergeCheckState } | undefined>;
  let slot = g[MERGE_KEY];
  if (!slot) {
    slot = {
      state: {
        startedAt: null,
        intervalMs: null,
        lastTickAt: null,
        lastError: null,
        lastChecked: null,
        lastMergedTaskId: null,
        totalChecked: 0,
        totalMerged: 0,
        tickCount: 0
      }
    };
    g[MERGE_KEY] = slot;
  }
  return slot;
}

export function getSchedulerState(): SchedulerState {
  return { ...box().state };
}

export function getWorkerSweepState(): WorkerSweepState {
  return { ...sweepBox().state };
}

export function getMergeCheckState(): MergeCheckState {
  return { ...mergeBox().state };
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

// Worker 离线扫描：与 promote 同 tick 执行，独立 record；error 仅 warn 不阻塞主流程，
// 故失败也算一次 tick（计数 + 错误信息），不像 promote 跳过累计。
export function recordWorkerSweepTick(offlined: number, atIso: string, error: string | null): void {
  const s = sweepBox().state;
  s.lastTickAt = atIso;
  s.lastError = error;
  s.tickCount += 1;
  if (!error) {
    s.lastOfflined = offlined;
    s.totalOfflined += offlined;
  }
}

export function recordMergeCheckStart(intervalMs: number, atIso: string): void {
  const s = mergeBox().state;
  s.startedAt = atIso;
  s.intervalMs = intervalMs;
}

// merge-check tick 三种结果：
//   - 无候选（candidate=null）：仅刷新 lastTickAt（不计入 totalChecked，避免空轮把"累计已查"刷成大数）
//   - 已查（merged=true/false）：计 totalChecked，merged 时计 totalMerged + 记任务 id
//   - 错误：记 lastError；tickCount 仍 +1 便于追踪频度
export function recordMergeCheckTick(
  atIso: string,
  result: { checkedTaskId: string | null; merged: boolean; error: string | null }
): void {
  const s = mergeBox().state;
  s.lastTickAt = atIso;
  s.lastError = result.error;
  s.tickCount += 1;
  if (result.error) {
    return;
  }
  if (result.checkedTaskId) {
    s.lastChecked = result.checkedTaskId;
    s.totalChecked += 1;
    if (result.merged) {
      s.lastMergedTaskId = result.checkedTaskId;
      s.totalMerged += 1;
    }
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

// Worker sweep 复用 promote 的 interval（同 tick 执行），健康判定参考 promote 的 lastTickAt：
// 故这里仅判错误 + 是否至少执行过一次。
export function isWorkerSweepHealthy(s: WorkerSweepState): boolean {
  return s.lastTickAt !== null && !s.lastError;
}

export function isMergeCheckHealthy(s: MergeCheckState): boolean {
  if (!s.startedAt || !s.lastTickAt || !s.intervalMs) {
    return false;
  }
  if (s.lastError) {
    return false;
  }
  const sinceMs = Date.now() - new Date(s.lastTickAt).getTime();
  return sinceMs <= s.intervalMs * 3;
}
