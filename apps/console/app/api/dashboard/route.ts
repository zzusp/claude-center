import {
  countScheduledTasks,
  getPool,
  getPoolStats,
  listRecentTasksForUser,
  listWorkers,
  pingDatabase
} from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";
import { getSchedulerState, isSchedulerHealthy } from "../../lib/scheduler-state";

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
    // dbLatencyMs / scheduledPending 一并入 Promise.all，健康数据复用同一轮询、不另起请求。
    const [workers, tasks, dbLatencyMs, scheduledPending] = await Promise.all([
      listWorkers(pool),
      listRecentTasksForUser(pool, user, 80),
      pingDatabase(pool),
      countScheduledTasks(pool)
    ]);

    const scheduler = getSchedulerState();

    return NextResponse.json({
      workers,
      tasks,
      summary: {
        onlineWorkers: workers.filter((worker) => worker.status === "online").length,
        pendingTasks: tasks.filter((task) => task.status === "pending").length,
        runningTasks: tasks.filter((task) => task.status === "running" || task.status === "claimed").length,
        failedTasks: tasks.filter((task) => task.status === "failed").length
      },
      // 系统运行状态：DB 连接池 + 定时调度器。走到这里说明库可达，故 db.ok 恒 true。
      health: {
        db: { ok: true, latencyMs: dbLatencyMs, pool: getPoolStats(pool) },
        scheduler: { ...scheduler, scheduledPending, ok: isSchedulerHealthy(scheduler) }
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
