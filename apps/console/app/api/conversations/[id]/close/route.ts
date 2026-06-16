import { closeConversation, getConversation, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse } from "../../../../lib/api";

export const dynamic = "force-dynamic";

// 结束对话：置 closed，worker 不再认领其轮次。
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
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
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    await closeConversation(getPool(), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
