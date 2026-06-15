import { getPool, listWorkerProjectLinks } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

// 获取 worker 关联的项目列表（join projects 取展示字段）。登录即可访问。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) return gate;

  try {
    const { id } = await params;
    const links = await listWorkerProjectLinks(getPool(), id);
    return NextResponse.json({ links });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
