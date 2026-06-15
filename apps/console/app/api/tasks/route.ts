import {
  addTaskDependencies,
  createTask,
  getPool,
  listTasks,
  listUserProjectIds,
  userHasProject,
  type SortDir,
  type TaskModel
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { projectChannel, publishRelay } from "../../lib/relay-publish";

export const dynamic = "force-dynamic";

const TASK_STATUSES = ["draft", "scheduled", "pending", "claimed", "running", "waiting", "success", "failed", "cancelled"];
const MERGE_STATUSES = ["unknown", "unmerged", "merged"];
const PAGE_SIZES = [20, 50, 100];
const TASK_MODELS = ["default", "opus", "sonnet", "haiku"];

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

    const mergeStatus = (params.get("mergeStatus") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => MERGE_STATUSES.includes(value));

    const projectId = params.get("projectId")?.trim() || null;
    const q = params.get("q")?.trim() || null;

    // 排序方向：表头切换 updated_at 升/降序，白名单 asc/desc，默认 desc。
    const dir: SortDir = params.get("dir") === "asc" ? "asc" : "desc";

    const pageSizeRaw = Number(params.get("pageSize"));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 20;

    const pageRaw = Number(params.get("page"));
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

    // 项目级隔离：非 admin 只返回分配给自己项目的任务（projectIds 与单项目筛选 AND 叠加）。
    const projectIds = user.role === "admin" ? null : await listUserProjectIds(getPool(), user.id);

    const { tasks, total } = await listTasks(getPool(), {
      status,
      mergeStatus,
      projectId,
      projectIds,
      q,
      dir,
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
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetBranch?: string;
      submitMode?: string;
      autoMergePr?: boolean;
      model?: string;
      dependsOn?: string[];
      scheduledAt?: string;
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return NextResponse.json({ error: "Project, title and description are required" }, { status: 400 });
    }

    // 定时发布时间（可选）：必须可解析且为将来时间；落 scheduled 态，到点由调度器转 pending。
    let scheduledAt: string | null = null;
    const scheduledRaw = body.scheduledAt?.trim();
    if (scheduledRaw) {
      const when = new Date(scheduledRaw);
      if (Number.isNaN(when.getTime())) {
        return NextResponse.json({ error: "定时发布时间格式无效" }, { status: 400 });
      }
      if (when.getTime() <= Date.now()) {
        return NextResponse.json({ error: "定时发布时间必须晚于当前时间" }, { status: 400 });
      }
      scheduledAt = when.toISOString();
    }

    // 项目隔离：非 admin 只能在分配给自己的项目里建任务。
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, body.projectId))) {
      return NextResponse.json({ error: "无权在该项目下创建任务" }, { status: 403 });
    }

    const baseBranch = body.baseBranch?.trim() || "main";
    const submitMode = body.submitMode === "push" ? "push" : "pr";
    // 自动合并 PR 仅对 PR 模式有效：push 模式直推目标分支、无 PR 可合。
    const autoMergePr = submitMode === "pr" && body.autoMergePr === true;

    // 执行模型白名单校验：非法 / 缺省一律落 'default'（Worker 执行时不传 --model）。
    const model: TaskModel =
      typeof body.model === "string" && TASK_MODELS.includes(body.model) ? (body.model as TaskModel) : "default";

    const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.filter((id) => typeof id === "string") : [];

    // 任务与其前置依赖须原子入库：依赖校验失败（跨项目 / 不存在）应整体回滚。
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await createTask(client, {
        projectId: body.projectId,
        title: body.title.trim(),
        description: body.description.trim(),
        baseBranch,
        workBranch: body.workBranch?.trim() || defaultWorkBranch(body.title),
        targetBranch: body.targetBranch?.trim() || baseBranch,
        submitMode,
        autoMergePr,
        model,
        scheduledAt
      });
      await addTaskDependencies(client, task.id, dependsOn);
      await client.query("COMMIT");
      publishRelay({
        channel: projectChannel(task.project_id),
        type: "task.upserted",
        entityId: task.id,
        projectId: task.project_id,
        seq: task.updated_at,
        payload: task
      });
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
