import { addConversationMessage, getConversation, getPool, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { projectChannel, publishRelay } from "../../../../lib/relay-publish";

export const dynamic = "force-dynamic";

// 发用户消息：插一条 role='user'，worker 下一轮 tick 据「最后一条是 user」认领并流式应答。
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as { body?: string };
    if (!body.body?.trim()) {
      return NextResponse.json({ error: "消息内容必填" }, { status: 400 });
    }
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    if (conversation.status !== "active") {
      return NextResponse.json({ error: "对话已结束" }, { status: 400 });
    }
    const message = await addConversationMessage(getPool(), { conversationId: id, role: "user", body: body.body.trim() });
    // 落库后即推到项目频道：会话的 worker 已关联该项目（创建时校验），会收到并立即认领应答。
    publishRelay({
      channel: projectChannel(conversation.project_id),
      type: "conversation.message",
      entityId: id,
      projectId: conversation.project_id,
      seq: message.seq,
      payload: message
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
