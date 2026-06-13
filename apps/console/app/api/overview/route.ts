import { getPool, listProjectsForUser, listRecentDirectCommands, listRecentTasksForUser, listWorkers } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const pool = getPool();
    const isAdmin = user.role === "admin";
    // projects / tasks 按用户项目范围过滤；定向指挥回执仅 admin 可见。
    const [projects, workers, tasks, commands] = await Promise.all([
      listProjectsForUser(pool, user),
      listWorkers(pool),
      listRecentTasksForUser(pool, user, 80),
      isAdmin ? listRecentDirectCommands(pool, 40) : Promise.resolve([])
    ]);

    return NextResponse.json({
      projects,
      workers,
      tasks,
      commands,
      summary: {
        onlineWorkers: workers.filter((worker) => worker.status === "online").length,
        pendingTasks: tasks.filter((task) => task.status === "pending").length,
        runningTasks: tasks.filter((task) => task.status === "running" || task.status === "claimed").length,
        failedTasks: tasks.filter((task) => task.status === "failed").length
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
