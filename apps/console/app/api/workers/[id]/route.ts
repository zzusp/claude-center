import { deleteWorker, getPool, getWorker, updateWorkerLabel } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";
import { errorResponse } from "../../../lib/api";

export const dynamic = "force-dynamic";

// 单个 worker 详情，供详情页轮询。登录即可访问。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;

  try {
    const { id } = await params;
    const worker = await getWorker(getPool(), id);
    if (!worker) {
      return NextResponse.json({ error: "Worker 不存在" }, { status: 404 });
    }
    return NextResponse.json({ worker });
  } catch (error) {
    return errorResponse(error);
  }
}

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
    return errorResponse(error);
  }
}

// 删除 worker 记录，需 command.create（admin）权限。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) return gate;

  try {
    const { id } = await params;
    const deleted = await deleteWorker(getPool(), id);
    if (!deleted) {
      return NextResponse.json({ error: "Worker 不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
