import { countUnreadNotifications, getPool, listNotifications } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";
import { errorResponse } from "../../lib/api";

export const dynamic = "force-dynamic";

// 顶栏铃铛下拉聚合接口：返回本人最近 30 条通知 + 未读条数。
// 鉴权：登录即可读自己的通知；通知是按收件人写入，自然按用户过滤，不需要再加 RBAC 项目范围。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const pool = getPool();
    const [items, unread] = await Promise.all([
      listNotifications(pool, user.id, 30),
      countUnreadNotifications(pool, user.id)
    ]);
    return NextResponse.json({ items, unread });
  } catch (error) {
    return errorResponse(error);
  }
}
