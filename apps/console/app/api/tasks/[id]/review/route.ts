import { acceptTask, getPool, rejectTask } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { requireTaskAccess } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";
import { projectChannel, publishRelay } from "../../../../lib/relay-publish";

export const dynamic = "force-dynamic";

// 人工验收：accept 翻为终态 accepted；reject 落打回意见并翻为 rejected（Worker 续接重跑）。
// accept/reject 各自在事务内完成，非「待验收(success)」状态返回 409。
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as { action?: "accept" | "reject"; feedback?: string };

    if (body.action !== "accept" && body.action !== "reject") {
      return badRequest("action must be 'accept' or 'reject'");
    }
    if (body.action === "reject" && !body.feedback?.trim()) {
      return badRequest("打回必须填写意见");
    }

    // 项目隔离：非 admin 只能验收分配给自己项目下的任务。
    const denied = await requireTaskAccess(user, id, "无权验收该任务");
    if (denied) {
      return denied;
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task =
        body.action === "accept"
          ? await acceptTask(client, id)
          : await rejectTask(client, id, body.feedback!.trim());

      if (!task) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "任务不在待验收状态" }, { status: 409 });
      }

      await client.query("COMMIT");
      publishRelay({
        channel: projectChannel(task.project_id),
        type: "task.upserted",
        entityId: task.id,
        projectId: task.project_id,
        seq: task.updated_at,
        payload: task
      });
      return NextResponse.json({ task }, { status: 200 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
