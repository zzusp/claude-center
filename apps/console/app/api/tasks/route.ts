import { createTask, getPool, listTasks, listUserProjectIds, userHasProject, type TaskSort } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";

export const dynamic = "force-dynamic";

const TASK_STATUSES = ["draft", "pending", "claimed", "running", "waiting", "success", "failed", "cancelled"];
const SORT_VALUES: TaskSort[] = ["updated", "created", "priority"];
const PAGE_SIZES = [20, 50, 100];

export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
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

    // 项目级隔离：非 admin 只返回分配给自己项目的任务（projectIds 与单项目筛选 AND 叠加）。
    const projectIds = user.role === "admin" ? null : await listUserProjectIds(getPool(), user.id);

    const { tasks, total } = await listTasks(getPool(), {
      status,
      projectId,
      projectIds,
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
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const body = (await request.json()) as {
      projectId?: string;
      taskType?: string;
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetBranch?: string;
      submitMode?: string;
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

    const taskType = body.taskType === "qa" ? "qa" : "work";

    // 问答类不碰 git：分支 / 目标文件对它无意义，统一存空。
    const targetFiles =
      taskType === "qa"
        ? []
        : (body.targetFilesText ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

    const baseBranch = body.baseBranch?.trim() || "main";
    const submitMode = body.submitMode === "push" ? "push" : "pr";

    const task = await createTask(getPool(), {
      projectId: body.projectId,
      taskType,
      title: body.title.trim(),
      description: body.description.trim(),
      baseBranch: taskType === "qa" ? "" : baseBranch,
      workBranch: taskType === "qa" ? "" : body.workBranch?.trim() || defaultWorkBranch(body.title),
      targetBranch: taskType === "qa" ? "" : body.targetBranch?.trim() || baseBranch,
      submitMode: taskType === "qa" ? "pr" : submitMode,
      targetFiles,
      priority: Number.isFinite(body.priority) ? Number(body.priority) : 0
    });

    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
