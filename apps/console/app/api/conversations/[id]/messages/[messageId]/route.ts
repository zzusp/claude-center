import { deleteScheduledConversationMessage, getConversation, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../../lib/session";
import { requireProjectScope } from "../../../../../lib/access";
import { errorResponse, badRequest } from "../../../../../lib/api";

export const dynamic = "force-dynamic";

// 取消一条尚未到点的定时消息（仅 status='scheduled' 可删）。复用 command.create 权限，按项目可见性校验。
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id, messageId } = await params;
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    const ok = await deleteScheduledConversationMessage(getPool(), id, messageId);
    if (!ok) {
      return badRequest("该消息不存在或已发送，无法取消");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
