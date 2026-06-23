import { deleteProject, getPool, getProject, updateProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../lib/session";
import { errorResponse, badRequest } from "../../../lib/api";

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

    // vcs 不可改：按项目现有类型决定校验。非 git 项目不要求 repo_url。
    const existing = await getProject(getPool(), id);
    if (!existing) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    const isGit = existing.vcs === "git";
    if (!body.name?.trim()) {
      return badRequest("项目名不能为空");
    }
    if (isGit && !body.repoUrl?.trim()) {
      return badRequest("Git 项目的仓库地址不能为空");
    }

    const updated = await updateProject(getPool(), id, {
      name: body.name.trim(),
      repoUrl: isGit ? body.repoUrl!.trim() : null,
      defaultBranch: isGit ? body.defaultBranch?.trim() || "main" : "",
      description: body.description?.trim() ?? ""
    });
    if (!updated) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }

    return NextResponse.json({ project: updated });
  } catch (error) {
    return errorResponse(error);
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
    return errorResponse(error);
  }
}
