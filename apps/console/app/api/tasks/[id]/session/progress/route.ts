import { getPool, getTaskSession } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../../lib/session";
import { requireTaskAccess } from "../../../../../lib/access";
import { errorResponse } from "../../../../../lib/api";
import { summarizeTranscript } from "../../../../../lib/transcript-summary";

export const dynamic = "force-dynamic";

// 执行存活信号：把 session transcript 压成 compact 摘要（最近活动 / 步数 / 当前步），不回传整段 blob。
// 概览在途（running）时 5s 轮询此端点，用于区分「在跑」与「卡死」——里程碑在 claude 整轮跑完前会冻结在
// 「开始执行」，光看里程碑无法判断（docs/spec/worktree-exec-observability.md §1）。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下任务的执行进度。
    const denied = await requireTaskAccess(user, id);
    if (denied) {
      return denied;
    }
    const session = await getTaskSession(getPool(), id);
    const summary = summarizeTranscript(session?.jsonl ?? null);
    return NextResponse.json({ ...summary, syncedAt: session?.synced_at ?? null });
  } catch (error) {
    return errorResponse(error);
  }
}
