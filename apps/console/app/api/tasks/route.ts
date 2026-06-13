import { createTask, getPool, userHasProject } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../lib/session";

function defaultWorkBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `cc/${slug || "task"}-${Date.now()}`;
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const body = (await request.json()) as {
      projectId?: string;
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetFilesText?: string;
      priority?: number;
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return NextResponse.json({ error: "Project, title and description are required" }, { status: 400 });
    }

    // 项目隔离：非 admin 只能在分配给自己的项目里建任务。
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, body.projectId))) {
      return NextResponse.json({ error: "无权在该项目下创建任务" }, { status: 403 });
    }

    const targetFiles = (body.targetFilesText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const task = await createTask(getPool(), {
      projectId: body.projectId,
      title: body.title.trim(),
      description: body.description.trim(),
      baseBranch: body.baseBranch?.trim() || "main",
      workBranch: body.workBranch?.trim() || defaultWorkBranch(body.title),
      targetFiles,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : 0
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
