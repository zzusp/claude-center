import { getPool, listTaskEvents } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";
import { requireTaskAccess } from "../../../../lib/access";
import { errorResponse } from "../../../../lib/api";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下任务的事件。
    const denied = await requireTaskAccess(user, id);
    if (denied) {
      return denied;
    }
    const events = await listTaskEvents(getPool(), id);
    return NextResponse.json({ events });
  } catch (error) {
    return errorResponse(error);
  }
}
