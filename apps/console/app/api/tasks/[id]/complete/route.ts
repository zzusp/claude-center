import { completeQaTask, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";

// 用户在对话区点「结束对话」：把问答类任务收口为 success。
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const task = await completeQaTask(getPool(), id);
    if (!task) {
      return NextResponse.json({ error: "无法结束：仅问答类且未完成的任务可结束对话" }, { status: 409 });
    }
    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
