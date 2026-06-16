import { getPool, getTaskSession } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";
import { requireTaskAccess } from "../../../../lib/access";
import { errorResponse } from "../../../../lib/api";

export const dynamic = "force-dynamic";

// 任务执行会话 transcript（Claude Code session .jsonl 全文 + 同步时间）。独立端点：不并入 /api/tasks/[id]
// 的高频轮询，避免每次都拖大 blob。Console 详情页按需（终态前轮询、终态后停拉）取一次解析渲染。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下任务的会话记录。
    const denied = await requireTaskAccess(user, id);
    if (denied) {
      return denied;
    }
    const session = await getTaskSession(getPool(), id);
    return NextResponse.json({ jsonl: session?.jsonl ?? null, syncedAt: session?.synced_at ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
