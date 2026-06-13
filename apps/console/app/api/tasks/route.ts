import { addTaskDependencies, createTask, getPool, listTasks, type TaskSort } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TASK_STATUSES = ["draft", "pending", "claimed", "running", "waiting", "success", "failed", "cancelled"];
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
      taskType?: string;
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetBranch?: string;
      submitMode?: string;
      targetFilesText?: string;
      priority?: number;
      dependsOn?: string[];
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

    const baseBranch = body.baseBranch?.trim() || "main";
    const submitMode = body.submitMode === "push" ? "push" : "pr";

    const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.filter((id) => typeof id === "string") : [];

    // 任务与其前置依赖须原子入库：依赖校验失败（跨项目 / 不存在）应整体回滚。
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await createTask(client, {
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
