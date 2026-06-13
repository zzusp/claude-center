import { getPool, getTaskProjectId, publishTask, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../lib/session";

// 任务状态切换：目前仅支持 publish（草稿 → 待处理，进入可认领队列）。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as { action?: string };

    if (body.action !== "publish") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    // 项目隔离：非 admin 只能发布分配给自己项目下的任务。
    if (user.role !== "admin") {
      const projectId = await getTaskProjectId(getPool(), id);
      if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
        return NextResponse.json({ error: "无权操作该任务" }, { status: 403 });
      }
    }

    const task = await publishTask(getPool(), id);
    if (!task) {
      return NextResponse.json({ error: "任务不存在或不是草稿状态" }, { status: 409 });
    }

    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
