import { addTaskDependencies, createTask, getPool } from "@claude-center/db";
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
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetFilesText?: string;
      priority?: number;
      dependsOn?: string[];
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return NextResponse.json({ error: "Project, title and description are required" }, { status: 400 });
    }

    const targetFiles = (body.targetFilesText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.filter((id) => typeof id === "string") : [];

    // 任务与其前置依赖须原子入库：依赖校验失败（跨项目 / 不存在）应整体回滚。
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await createTask(client, {
        projectId: body.projectId,
        title: body.title.trim(),
        description: body.description.trim(),
        baseBranch: body.baseBranch?.trim() || "main",
        workBranch: body.workBranch?.trim() || defaultWorkBranch(body.title),
        targetFiles,
        priority: Number.isFinite(body.priority) ? Number(body.priority) : 0
      });
      await addTaskDependencies(client, task.id, dependsOn);
      await client.query("COMMIT");
      return NextResponse.json({ task }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
