// Console 后台定时任务调度器。Next.js 在服务进程启动时调用一次 register()；这里起一个
// 周期定时器，把到点的定时任务（scheduled → pending）提升进可认领队列，供在线 Worker 领取。
// 方案见 docs/spec/task-scheduled.md。
//
// 仅在 nodejs 运行时启用（edge 运行时连不了 pg）。用 globalThis 标志位防 dev HMR 重复起定时器。

import { detectBranchMerged } from "./app/lib/merge-check";
import { recordSchedulerStart, recordSchedulerTick } from "./app/lib/scheduler-state";

const DEFAULT_INTERVAL_MS = 30_000;
// 合并检查独立间隔：默认 60s，刻意慢于 Worker 轮询（默认 10s），让在线 Worker 优先把已合并 PR
// 转入 merged 并清理分支；Worker 离线时由 Console 兜底自动验收。方案见 docs/spec/task-merge-status-check.md。
const DEFAULT_MERGE_CHECK_INTERVAL_MS = 60_000;

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
  const {
    getPool,
    promoteDueScheduledTasks,
    claimNextMergeCheckCandidate,
    markTaskMergeAccepted,
    setTaskMergeUnmerged
  } = await import(/* webpackIgnore: true */ "@claude-center/db");

  const parsed = Number(process.env.CLAUDE_CENTER_SCHEDULER_INTERVAL_MS);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS;

  async function tick(): Promise<void> {
    try {
      const promoted = await promoteDueScheduledTasks(getPool());
      recordSchedulerTick(promoted, new Date().toISOString(), null);
      if (promoted > 0) {
        console.log(`[scheduler] 提升 ${promoted} 个到点定时任务进入待处理队列`);
      }
    } catch (error) {
      recordSchedulerTick(0, new Date().toISOString(), error instanceof Error ? error.message : String(error));
      console.error("[scheduler] 提升定时任务失败：", error);
    }
  }

  recordSchedulerStart(intervalMs, new Date().toISOString());
  // 启动即跑一次，随后周期跑。unref 让定时器不阻止进程退出。
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  console.log(`[scheduler] 定时任务调度器已启动，每 ${intervalMs}ms 检查一次`);

  // 合并检查循环：每轮取 1 个 success 待验收工作任务，远程判定 work_branch 是否已并入 target_branch，
  // 已合并则自动转 accepted。独立间隔 + 非重入，慢网络调用不阻塞上面的定时发布提升。
  const mergeParsed = Number(process.env.CLAUDE_CENTER_MERGE_CHECK_INTERVAL_MS);
  const mergeIntervalMs =
    Number.isFinite(mergeParsed) && mergeParsed >= 1000 ? mergeParsed : DEFAULT_MERGE_CHECK_INTERVAL_MS;
  const ghCommand = process.env.GH_COMMAND || "gh";
  let mergeChecking = false;

  async function mergeTick(): Promise<void> {
    if (mergeChecking) {
      return;
    }
    mergeChecking = true;
    try {
      const candidate = await claimNextMergeCheckCandidate(getPool());
      if (!candidate) {
        return;
      }
      const merged = await detectBranchMerged({
        repoUrl: candidate.repo_url,
        prUrl: candidate.pr_url,
        workBranch: candidate.work_branch,
        targetBranch: candidate.target_branch,
        ghCommand
      });
      if (merged) {
        const accepted = await markTaskMergeAccepted(getPool(), candidate.id);
        if (accepted) {
          console.log(
            `[merge-check] 任务 ${candidate.id}（${candidate.work_branch} → ${candidate.target_branch}）已合并，自动验收`
          );
        }
      } else {
        await setTaskMergeUnmerged(getPool(), candidate.id);
      }
    } catch (error) {
      console.error("[merge-check] 合并检查失败：", error);
    } finally {
      mergeChecking = false;
    }
  }

  void mergeTick();
  const mergeTimer = setInterval(() => void mergeTick(), mergeIntervalMs);
  mergeTimer.unref?.();
  console.log(`[merge-check] 合并检查循环已启动，每 ${mergeIntervalMs}ms 检查一个待验收任务`);
}
