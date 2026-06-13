// Console 后台定时任务调度器。Next.js 在服务进程启动时调用一次 register()；这里起一个
// 周期定时器，把到点的定时任务（scheduled → pending）提升进可认领队列，供在线 Worker 领取。
// 方案见 docs/spec/task-scheduled.md。
//
// 仅在 nodejs 运行时启用（edge 运行时连不了 pg）。用 globalThis 标志位防 dev HMR 重复起定时器。

const DEFAULT_INTERVAL_MS = 30_000;

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const globalKey = Symbol.for("claude-center.scheduler.started");
  const flags = globalThis as unknown as Record<symbol, boolean>;
  if (flags[globalKey]) {
    return;
  }
  flags[globalKey] = true;

  // webpackIgnore：让 webpack 完全不追踪此动态 import，保留为运行时 import 由 Node 解析。
  // 否则 webpack 会把 @claude-center/db → pg 拖进 instrumentation 模块图，pg 内部 require('fs')
  // 在 edge/fallback 编译下报 "Can't resolve 'fs'"，拖垮整个 dev server。此 import 只在
  // nodejs 运行时执行（上面已 guard），故 Node 能正常从 node_modules require 到 pg。
  const { getPool, promoteDueScheduledTasks } = await import(/* webpackIgnore: true */ "@claude-center/db");

  const parsed = Number(process.env.CLAUDE_CENTER_SCHEDULER_INTERVAL_MS);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS;

  async function tick(): Promise<void> {
    try {
      const promoted = await promoteDueScheduledTasks(getPool());
      if (promoted > 0) {
        console.log(`[scheduler] 提升 ${promoted} 个到点定时任务进入待处理队列`);
      }
    } catch (error) {
      console.error("[scheduler] 提升定时任务失败：", error);
    }
  }

  // 启动即跑一次，随后周期跑。unref 让定时器不阻止进程退出。
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  console.log(`[scheduler] 定时任务调度器已启动，每 ${intervalMs}ms 检查一次`);
}
