import { getPool, listProjectsForUser, listRecentTasksForUser, listWorkers } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";

export const dynamic = "force-dynamic";

// 侧边栏徽标计数：跨页保持新鲜的轻量轮询。口径沿用 overview（tasks 取最近 80 条同源计数），
// 心跳（synced / lastSyncAt）由客户端按本请求成败派生，不在服务端返回。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const pool = getPool();
    const [projects, workers, tasks] = await Promise.all([
      listProjectsForUser(pool, user),
      listWorkers(pool),
      listRecentTasksForUser(pool, user, 80)
    ]);
    return NextResponse.json({
      counts: { tasks: tasks.length, workers: workers.length, projects: projects.length }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
