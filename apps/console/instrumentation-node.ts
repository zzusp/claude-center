// Console 后台调度逻辑的 nodejs-only 实现。被 instrumentation.ts 仅在 NEXT_RUNTIME==="nodejs" 的正向
// 分支里动态 import，故整模块永不进入 Edge 编译图——这样用 node: 内置的 merge-check 才不会触发
// Turbopack/webpack 的「node: not supported in Edge Runtime」。方案见 docs/spec/task-scheduled.md
// 与 docs/spec/drop-accepted-rejected.md。
//
// 起两条周期定时器:
//   1) 调度器(30s):把到点定时任务 scheduled → pending,提升进可认领队列。
//   2) 合并检查(30s):取一个 success 且有 PR 的任务,远程判定 PR 是否已合并;
//      已合并 → 翻 merged(终态),不再清理 worktree(用户仍可在本地复用)。
//      没有 PR 的 success 是终态,不参与本检查(用户的简化要求)。
// 用 globalThis 标志位防 dev HMR 重复起定时器。

import { detectBranchMerged } from "./app/lib/merge-check";
import { recordSchedulerStart, recordSchedulerTick } from "./app/lib/scheduler-state";

const DEFAULT_INTERVAL_MS = 30_000;
// 合并检查间隔:30s 一次(spec drop-accepted-rejected.md §3「定时任务,30s 一次」)。
const DEFAULT_MERGE_CHECK_INTERVAL_MS = 30_000;

export async function registerNode(): Promise<void> {
  const globalKey = Symbol.for("claude-center.scheduler.started");
  const flags = globalThis as unknown as Record<symbol, boolean>;
  if (flags[globalKey]) {
    return;
  }
  flags[globalKey] = true;

  // webpackIgnore：让 webpack 完全不追踪此动态 import，保留为运行时 import 由 Node 解析。
  // 否则 webpack 会把 @claude-center/db → pg 拖进模块图，pg 内部 require('fs') 在 edge/fallback 编译下
  // 报 "Can't resolve 'fs'"。db 有 dist 产物，运行时由 Node 从 node_modules 正常解析。
  const {
    getPool,
    promoteDueScheduledTasks,
    claimNextMergeCheckCandidate,
    markTaskMerged,
    setTaskMergeUnmerged
  } = await import(/* webpackIgnore: true */ "@claude-center/db");

  const parsed = Number(process.env.CLAUDE_CENTER_SCHEDULER_INTERVAL_MS);
  const intervalMs = Number.isFinite(parsed) && parsed >= 1000 ? parsed : DEFAULT_INTERVAL_MS;

  // 防重入：与 mergeTick 一致。promoteDueScheduledTasks 虽是单条幂等 UPDATE，但若某轮耗时超过
  // 间隔，无守卫会并发跑两次（重复 recordSchedulerTick / 日志），加旗标对齐两条循环的语义。
  let promoting = false;

  async function tick(): Promise<void> {
    if (promoting) {
      return;
    }
    promoting = true;
    try {
      const promoted = await promoteDueScheduledTasks(getPool());
      recordSchedulerTick(promoted, new Date().toISOString(), null);
      if (promoted > 0) {
        console.log(`[scheduler] 提升 ${promoted} 个到点定时任务进入待处理队列`);
      }
    } catch (error) {
      recordSchedulerTick(0, new Date().toISOString(), error instanceof Error ? error.message : String(error));
      console.error("[scheduler] 提升定时任务失败：", error);
    } finally {
      promoting = false;
    }
  }

  recordSchedulerStart(intervalMs, new Date().toISOString());
  // 启动即跑一次，随后周期跑。unref 让定时器不阻止进程退出。
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  console.log(`[scheduler] 定时任务调度器已启动，每 ${intervalMs}ms 检查一次`);

  // 合并检查循环:每轮取 1 个「success 且有 PR」的任务,远程判定 PR 是否已合并;
  // 已合并即翻 merged(终态),不清理 worktree(spec drop-accepted-rejected.md)。
  // 独立间隔 + 非重入,慢网络调用不阻塞上面的定时发布提升。
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
        const ok = await markTaskMerged(getPool(), candidate.id);
        if (ok) {
          console.log(
            `[merge-check] 任务 ${candidate.id}（${candidate.work_branch} → ${candidate.target_branch}）PR 已合并，翻入 merged 终态`
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
  console.log(`[merge-check] 合并检查循环已启动，每 ${mergeIntervalMs}ms 检查一个 success 且有 PR 的任务`);
}
