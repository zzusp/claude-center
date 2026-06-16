import { addTaskComment, getPool, getTaskProjectId, listTaskComments } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../../lib/session";
import { requireTaskAccess } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";
import { projectChannel, publishRelay } from "../../../../lib/relay-publish";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await requireTaskAccess(gate, id);
    if (denied) {
      return denied;
    }
    const comments = await listTaskComments(getPool(), id);
    return NextResponse.json({ comments });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.comment");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await requireTaskAccess(gate, id);
    if (denied) {
      return denied;
    }

    const body = (await request.json()) as { body?: string };
    if (!body.body?.trim()) {
      return badRequest("Reply body is required");
    }

    const comment = await addTaskComment(getPool(), {
      taskId: id,
      author: "user",
      workerId: null,
      body: body.body.trim()
    });

    // 用户回复落库后推到项目频道：waiting 任务的 Worker 收到即续接同一会话重跑。
    const projectId = await getTaskProjectId(getPool(), id);
    if (projectId) {
      publishRelay({
        channel: projectChannel(projectId),
        type: "task.comment",
        entityId: id,
        projectId,
        seq: comment.created_at,
        payload: comment
      });
    }
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
