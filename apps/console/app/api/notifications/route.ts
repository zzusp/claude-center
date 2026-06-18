import { countUnreadNotifications, getPool, listNotifications } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";
import { errorResponse } from "../../lib/api";

export const dynamic = "force-dynamic";

// 单次返回上限：弹窗「加载更多」最多翻到 200 条，避免被构造大 limit 拖库。
const MAX_LIMIT = 200;
// 缺省条数：铃铛悬浮面板只看最新几条。
const DEFAULT_LIMIT = 8;

// 顶栏铃铛聚合接口：返回本人最近通知 + 未读条数。
// limit 由调用方决定（悬浮面板取 8、弹窗分页取 10/20/…），服务端钳到 [1, 200]。
// 鉴权：登录即可读自己的通知；通知是按收件人写入，自然按用户过滤，不需要再加 RBAC 项目范围。
export async function GET(request: Request) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  const raw = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  try {
    const pool = getPool();
    const [items, unread] = await Promise.all([
      listNotifications(pool, user.id, limit),
      countUnreadNotifications(pool, user.id)
    ]);
    return NextResponse.json({ items, unread });
  } catch (error) {
    return errorResponse(error);
  }
}
