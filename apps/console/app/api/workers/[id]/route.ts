import { getPool, updateWorkerLabel } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../lib/session";

export const dynamic = "force-dynamic";

// web 端重命名 worker：更新 label 字段（null/空字符串=清除，恢复显示机器名）。
// 需 command.create（admin）权限；worker 重注册不会覆盖 label。
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) return gate;

  try {
    const { id } = await params;
    const body = (await request.json()) as { label?: string };
    const label = typeof body.label === "string" ? body.label.trim() : null;

    const updated = await updateWorkerLabel(getPool(), id, label);
    if (!updated) {
      return NextResponse.json({ error: "Worker 不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, label: label || null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
