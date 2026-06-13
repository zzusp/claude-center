import { getPool, listProjects, listRecentDirectCommands, listRecentTasks, listWorkers } from "@claude-center/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pool = getPool();
    const [projects, workers, tasks, commands] = await Promise.all([
      listProjects(pool),
      listWorkers(pool),
      listRecentTasks(pool, 80),
      listRecentDirectCommands(pool, 40)
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
