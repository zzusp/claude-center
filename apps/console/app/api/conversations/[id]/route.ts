import { getConversation, getPool, listConversationMessages, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";

export const dynamic = "force-dynamic";

// 对话详情 + 历史消息。前端首屏渲染历史；流式中的 assistant 消息走 SSE。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    const messages = await listConversationMessages(getPool(), id);
    return NextResponse.json({ conversation, messages });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
