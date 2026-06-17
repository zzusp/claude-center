import { getPool, markAllNotificationsRead, markNotificationRead } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";
import { errorResponse } from "../../../lib/api";

export const dynamic = "force-dynamic";

// 标记已读：
//   POST /api/notifications/read           → 全部标记
//   POST /api/notifications/read { id }    → 单条标记
// 二合一减少前端逻辑；幂等：已读再点不报错。
export async function POST(request: Request) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" && body.id.trim() ? body.id.trim() : null;
    const pool = getPool();
    if (id) {
      await markNotificationRead(pool, user.id, id);
    } else {
      await markAllNotificationsRead(pool, user.id);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
