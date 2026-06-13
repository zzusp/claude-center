import { addTaskComment, getPool, getTaskProjectId, listTaskComments, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser, type AuthUser } from "../../../../lib/session";

// 校验用户对某任务所属项目的访问范围（admin 全通）。返回 null 表示放行，否则返回拦截响应。
async function denyIfOutOfScope(user: AuthUser, taskId: string): Promise<NextResponse | null> {
  if (user.role === "admin") {
    return null;
  }
  const projectId = await getTaskProjectId(getPool(), taskId);
  if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
    return NextResponse.json({ error: "无权访问该任务" }, { status: 403 });
  }
  return null;
}

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await denyIfOutOfScope(gate, id);
    if (denied) {
      return denied;
    }
    const comments = await listTaskComments(getPool(), id);
    return NextResponse.json({ comments });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.comment");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await denyIfOutOfScope(gate, id);
    if (denied) {
      return denied;
    }

    const body = (await request.json()) as { body?: string };
    if (!body.body?.trim()) {
      return NextResponse.json({ error: "Reply body is required" }, { status: 400 });
    }

    const comment = await addTaskComment(getPool(), {
      taskId: id,
      author: "user",
      workerId: null,
      body: body.body.trim()
    });

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
