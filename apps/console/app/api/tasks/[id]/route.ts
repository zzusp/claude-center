import { completeQaTask, getPool, publishTask } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";

// 任务状态切换：publish（草稿 → 待处理，进入可认领队列）、complete（问答类「结束对话」→ 已完成）。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as { action?: string };

    if (body.action === "publish") {
      const task = await publishTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "任务不存在或不是草稿状态" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    if (body.action === "complete") {
      const task = await completeQaTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法结束：仅问答类且未完成的任务可结束对话" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
