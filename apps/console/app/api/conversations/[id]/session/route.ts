import { getConversation, getConversationSession, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse } from "../../../../lib/api";

export const dynamic = "force-dynamic";

// 对话执行会话 transcript（Claude Code session .jsonl 全文 + 同步时间）。与任务 /api/tasks/[id]/session 同构：
// Worker 周期 3s + 终态把 session .jsonl 同步到 conversation_sessions，前端按需轮询（active 3s、closed 取一次即停）取一次解析富展示。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下对话的会话记录（admin 跳过取数直接放行）。
    if (user.role !== "admin") {
      const conversation = await getConversation(getPool(), id);
      if (!conversation) {
        return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
      }
      const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
      if (denied) {
        return denied;
      }
    }
    const session = await getConversationSession(getPool(), id);
    return NextResponse.json({ jsonl: session?.jsonl ?? null, syncedAt: session?.synced_at ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
