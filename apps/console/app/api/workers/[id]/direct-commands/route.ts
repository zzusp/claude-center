import { getPool, listWorkerDirectCommands } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { errorResponse } from "../../../../lib/api";

export const dynamic = "force-dynamic";

// 某 worker 的定向指令历史（含 stdout/stderr/退出码/失败原因），供详情页「下发命令」面板回显。
// 与下发同权限：command.create（admin）。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const commands = await listWorkerDirectCommands(getPool(), id);
    return NextResponse.json({ commands });
  } catch (error) {
    return errorResponse(error);
  }
}
