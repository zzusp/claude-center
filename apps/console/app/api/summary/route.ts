import { getPool, getSummaryCounts } from "@claude-center/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../lib/session";
import { errorResponse } from "../../lib/api";

export const dynamic = "force-dynamic";

// 侧边栏徽标计数：单条 SQL 计数，替代原来三个全量列表查询再 .length 的做法。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const counts = await getSummaryCounts(getPool(), user);
    return NextResponse.json({ counts });
  } catch (error) {
    return errorResponse(error);
  }
}
