import { getPool, getTaskProjectId, listTaskEvents, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下任务的事件。
    if (user.role !== "admin") {
      const projectId = await getTaskProjectId(getPool(), id);
      if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
        return NextResponse.json({ error: "无权访问该任务" }, { status: 403 });
      }
    }
    const events = await listTaskEvents(getPool(), id);
    return NextResponse.json({ events });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
