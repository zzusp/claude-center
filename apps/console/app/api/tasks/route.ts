import { createTask, getPool, listTasks, type TaskSort } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TASK_STATUSES = ["pending", "claimed", "running", "waiting", "success", "failed", "cancelled"];
const SORT_VALUES: TaskSort[] = ["updated", "created", "priority"];
const PAGE_SIZES = [20, 50, 100];

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;

    const status = (params.get("status") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => TASK_STATUSES.includes(value));

    const projectId = params.get("projectId")?.trim() || null;
    const q = params.get("q")?.trim() || null;

    const sortParam = params.get("sort") as TaskSort | null;
    const sort: TaskSort = sortParam && SORT_VALUES.includes(sortParam) ? sortParam : "updated";

    const pageSizeRaw = Number(params.get("pageSize"));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 20;

    const pageRaw = Number(params.get("page"));
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

    const { tasks, total } = await listTasks(getPool(), {
      status,
      projectId,
      q,
      sort,
      limit: pageSize,
      offset: (page - 1) * pageSize
    });

    return NextResponse.json({ tasks, total, page, pageSize });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

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
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return NextResponse.json({ error: "Project, title and description are required" }, { status: 400 });
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
