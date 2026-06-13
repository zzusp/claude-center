import { createTask, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";

function defaultWorkBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return `cc/${slug || "task"}-${Date.now()}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      projectId?: string;
      taskType?: string;
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

    const taskType = body.taskType === "qa" ? "qa" : "work";

    // 问答类不碰 git：分支 / 目标文件对它无意义，统一存空。
    const targetFiles =
      taskType === "qa"
        ? []
        : (body.targetFilesText ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

    const task = await createTask(getPool(), {
      projectId: body.projectId,
      taskType,
      title: body.title.trim(),
      description: body.description.trim(),
      baseBranch: taskType === "qa" ? "" : body.baseBranch?.trim() || "main",
      workBranch: taskType === "qa" ? "" : body.workBranch?.trim() || defaultWorkBranch(body.title),
      targetFiles,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : 0
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
