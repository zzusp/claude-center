import { deleteProject, getPool, updateProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../lib/session";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("project.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      name?: string;
      repoUrl?: string;
      defaultBranch?: string;
      description?: string;
    };

    if (!body.name?.trim() || !body.repoUrl?.trim()) {
      return NextResponse.json({ error: "项目名与仓库地址不能为空" }, { status: 400 });
    }

    const updated = await updateProject(getPool(), id, {
      name: body.name.trim(),
      repoUrl: body.repoUrl.trim(),
      defaultBranch: body.defaultBranch?.trim() || "main",
      description: body.description?.trim() ?? ""
    });
    if (!updated) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    return NextResponse.json({ project: updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("project.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    // 其下任务等关联记录由外键级联删除（见 deleteProject 注释）。taskCount 供前端提示「含 N 个任务」。
    const { deleted, taskCount } = await deleteProject(getPool(), id);
    if (!deleted) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, taskCount });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
