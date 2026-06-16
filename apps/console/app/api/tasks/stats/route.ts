import { getPool, listTaskStatsForUser } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";
import { errorResponse } from "../../../lib/api";

export const dynamic = "force-dynamic";

// 任务流右侧栏统计接口：总量 / 状态分布 / 今日完成率 / 今日平均耗时。
// 今日窗口以服务端本地 0 点为界（与现网部署一致）；非 admin 自动按其 project 范围。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const stats = await listTaskStatsForUser(getPool(), user, todayStart.toISOString());
    return NextResponse.json(stats);
  } catch (error) {
    return errorResponse(error);
  }
}
