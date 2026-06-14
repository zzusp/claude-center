import { closeConversation, getConversation, getPool, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";

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
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    await closeConversation(getPool(), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
