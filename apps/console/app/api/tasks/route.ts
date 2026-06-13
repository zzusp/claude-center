import { createTask, getPool, type DeliveryMode } from "@claude-center/db";
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
      deliveryMode?: string;
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return NextResponse.json({ error: "Project, title and description are required" }, { status: 400 });
    }

    const targetFiles = (body.targetFilesText ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const deliveryMode: DeliveryMode = body.deliveryMode === "direct" ? "direct" : "pr";

    const task = await createTask(getPool(), {
      projectId: body.projectId,
      title: body.title.trim(),
      description: body.description.trim(),
      baseBranch: body.baseBranch?.trim() || "main",
      workBranch: body.workBranch?.trim() || defaultWorkBranch(body.title),
      targetFiles,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : 0,
      deliveryMode
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
