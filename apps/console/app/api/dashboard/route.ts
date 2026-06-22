import {
  countScheduledTasks,
  getPool,
  getPoolStats,
  listRecentTasksForUser,
  listTaskCompletionLast7ForUser,
  listTaskCreationLast7ForUser,
  listTaskMergedLast7ForUser,
  listWorkers,
  pingDatabase
} from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";
import { errorResponse } from "../../lib/api";
import {
  getMergeCheckState,
  getSchedulerState,
  getWorkerSweepState,
  isMergeCheckHealthy,
  isSchedulerHealthy,
  isWorkerSweepHealthy
} from "../../lib/scheduler-state";

export const dynamic = "force-dynamic";

// 总览页专用聚合：summary 卡片 + sparkline 数据源 + worker/任务流 + 运行健康。
// 等于原 /api/overview 去掉 projects（总览不用）与 commands（前端从未消费）。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const pool = getPool();
    // 「今日新任务」与 7 天 sparkline 用服务端本地零点反推，避免被 listRecentTasksForUser 的 80 条截断窗影响。
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartIso = todayStart.toISOString();

    // dbLatencyMs / scheduledPending 一并入 Promise.all，健康数据复用同一轮询、不另起请求。
    const [workers, tasks, dbLatencyMs, scheduledPending, dailyNewTasks, dailyCompletedTasks, dailyMergedTasks] =
      await Promise.all([
        listWorkers(pool),
        listRecentTasksForUser(pool, user, 80),
        pingDatabase(pool),
        countScheduledTasks(pool),
        listTaskCreationLast7ForUser(pool, user, todayStartIso),
        listTaskCompletionLast7ForUser(pool, user, todayStartIso),
        listTaskMergedLast7ForUser(pool, user, todayStartIso)
      ]);

    const scheduler = getSchedulerState();
    const workerSweep = getWorkerSweepState();
    const mergeCheck = getMergeCheckState();
    const todayNewTasks = dailyNewTasks[dailyNewTasks.length - 1] ?? 0;
    const todayCompletedTasks = dailyCompletedTasks[dailyCompletedTasks.length - 1] ?? 0;
    const todayMergedTasks = dailyMergedTasks[dailyMergedTasks.length - 1] ?? 0;

    return NextResponse.json({
      workers,
      tasks,
      summary: {
        onlineWorkers: workers.filter((worker) => worker.status === "online").length,
        todayNewTasks,
        todayCompletedTasks,
        todayMergedTasks
      },
      dailyNewTasks,
      dailyCompletedTasks,
      dailyMergedTasks,
      // 系统运行状态：DB 连接池 + 定时调度器（3 段子状态）。走到这里说明库可达，故 db.ok 恒 true。
      health: {
        db: { ok: true, latencyMs: dbLatencyMs, pool: getPoolStats(pool) },
        scheduler: {
          ...scheduler,
          scheduledPending,
          ok: isSchedulerHealthy(scheduler),
          workerSweep: { ...workerSweep, ok: isWorkerSweepHealthy(workerSweep) },
          mergeCheck: { ...mergeCheck, ok: isMergeCheckHealthy(mergeCheck) }
        }
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}
