import {
  addTaskDependencies,
  bindAttachmentsToTask,
  createTask,
  createTaskRepos,
  getPool,
  getProject,
  listProjectRepos,
  listTasks,
  listTaskStatsForUser,
  listUserProjectIds,
  userHasProject,
  TASK_STATUSES,
  type SortDir,
  type SortField,
  type TaskModel
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";
import { projectChannel, publishRelay } from "../../lib/relay-publish";
import { buildTaskRepoInputs, type TaskRepoUserInput } from "../../lib/task-repos-input";
import { MAX_ATTACHMENTS_PER_OWNER } from "../../lib/attachment-config";

export const dynamic = "force-dynamic";

// 状态过滤白名单复用 TASK_STATUSES 单一出处(曾因本地漏列导致「已合并」筛选被静默丢弃、返回全部)。
const MERGE_STATUSES = ["unknown", "unmerged", "merged"];
const SUBMIT_MODES = ["pr", "push"] as const;
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
      .filter((value) => (TASK_STATUSES as readonly string[]).includes(value));

    const mergeStatus = (params.get("mergeStatus") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => MERGE_STATUSES.includes(value));

    const projectId = params.get("projectId")?.trim() || null;
    const workerId = params.get("workerId")?.trim() || null;
    const submitModeRaw = params.get("submitMode")?.trim();
    const submitMode =
      submitModeRaw && (SUBMIT_MODES as readonly string[]).includes(submitModeRaw)
        ? (submitModeRaw as (typeof SUBMIT_MODES)[number])
        : null;
    const q = params.get("q")?.trim() || null;

    // 排序：列（created 创建时间 / tokens 累计 token 用量）+ 方向（asc/desc）均走白名单，默认 created desc。
    const sort: SortField = params.get("sort") === "tokens" ? "tokens" : "created";
    const dir: SortDir = params.get("dir") === "asc" ? "asc" : "desc";

    const pageSizeRaw = Number(params.get("pageSize"));
    const pageSize = PAGE_SIZES.includes(pageSizeRaw) ? pageSizeRaw : 20;

    const pageRaw = Number(params.get("page"));
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

    // 项目级隔离：非 admin 只返回分配给自己项目的任务（projectIds 与单项目筛选 AND 叠加）。
    const projectIds = user.role === "admin" ? null : await listUserProjectIds(getPool(), user.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [{ tasks, total }, stats] = await Promise.all([
      listTasks(getPool(), {
        status,
        mergeStatus,
        projectId,
        workerId,
        submitMode,
        projectIds,
        q,
        sort,
        dir,
        limit: pageSize,
        offset: (page - 1) * pageSize
      }),
      listTaskStatsForUser(getPool(), user, todayStart.toISOString())
    ]);

    return NextResponse.json({ tasks, total, page, pageSize, stats });
  } catch (error) {
    return errorResponse(error);
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
      autoReply?: boolean;
      autoDecisionHints?: string;
      model?: string;
      dynamicWorkflow?: boolean;
      dependsOn?: string[];
      scheduledAt?: string;
      // 多仓任务（spec docs/spec/task-multi-repo.md §UI）：每个项目仓的 base/work/target 与启用标志。
      // 缺省时按主仓单行生成（其它子仓默认 sub_status='skipped'），兼容旧前端。
      taskRepos?: TaskRepoUserInput[];
      // 附件 id 列表（先经 POST /api/attachments 上传得到 id）。事务里绑到本任务。
      attachmentIds?: string[];
    };

    if (!body.projectId || !body.title?.trim() || !body.description?.trim()) {
      return badRequest("Project, title and description are required");
    }

    // 定时发布时间（可选）：必须可解析且为将来时间；落 scheduled 态，到点由调度器转 pending。
    let scheduledAt: string | null = null;
    const scheduledRaw = body.scheduledAt?.trim();
    if (scheduledRaw) {
      const when = new Date(scheduledRaw);
      if (Number.isNaN(when.getTime())) {
        return badRequest("定时发布时间格式无效");
      }
      if (when.getTime() <= Date.now()) {
        return badRequest("定时发布时间必须晚于当前时间");
      }
      scheduledAt = when.toISOString();
    }

    // 项目隔离：非 admin 只能在分配给自己的项目里建任务。
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, body.projectId))) {
      return NextResponse.json({ error: "无权在该项目下创建任务" }, { status: 403 });
    }

    // 非 git 项目（vcs='none'，本地目录）：无分支 / 无 PR / 无多仓。分支字段一律空占位、不建 task_repos，
    // Worker 端按 localPath 下无 .git 走「就地修改」路径。git 项目行为完全不变。
    const project = await getProject(getPool(), body.projectId);
    if (!project) {
      return badRequest("项目不存在");
    }
    const isGit = project.vcs === "git";

    const baseBranch = isGit ? body.baseBranch?.trim() || "main" : "";
    // 提交模式 / 自动合并仅对 git 项目有意义。
    const submitMode = isGit && body.submitMode === "push" ? "push" : "pr";
    // 自动合并 PR 仅对 git 的 PR 模式有效：push 模式直推目标分支、无 PR 可合。
    const autoMergePr = isGit && submitMode === "pr" && body.autoMergePr === true;
    // 自动回复（兜底）：与 submit_mode 解耦，git / 非 git 均可用。hints 仅在 auto_reply=true 时有意义；不勾时一律落空串。
    const autoReply = body.autoReply === true;
    const autoDecisionHints = autoReply ? (body.autoDecisionHints ?? "").trim() : "";

    // 执行模型白名单校验：非法 / 缺省一律落 'default'（Worker 执行时不传 --model）。
    const model: TaskModel =
      typeof body.model === "string" && TASK_MODELS.includes(body.model) ? (body.model as TaskModel) : "default";
    // 动态工作流（Claude Code Workflows）：缺省关闭，仅显式 true 时启用。
    const dynamicWorkflow = body.dynamicWorkflow === true;

    const dependsOn = Array.isArray(body.dependsOn) ? body.dependsOn.filter((id) => typeof id === "string") : [];
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === "string")
      : [];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_OWNER) {
      return badRequest(`附件数量超过上限（${MAX_ATTACHMENTS_PER_OWNER}）`);
    }

    const workBranch = isGit ? body.workBranch?.trim() || defaultWorkBranch(body.title) : "";
    const targetBranch = isGit ? body.targetBranch?.trim() || baseBranch : "";
    // 多仓任务：解析 taskRepos[] 或按主仓单行兜底。在 createTask 同事务里插入 task_repos。
    // 非 git 项目不参与多仓机制（无 project_repos / task_repos）。
    let taskRepoInputs: ReturnType<typeof buildTaskRepoInputs> | null = null;
    if (isGit) {
      const projectRepos = await listProjectRepos(getPool(), body.projectId);
      if (projectRepos.length === 0) {
        return badRequest("项目仓清单为空（异常状态：主仓行应已由 createProject 自动同步）");
      }
      taskRepoInputs = buildTaskRepoInputs({
        projectRepos,
        body,
        baseBranch,
        workBranch,
        targetBranch
      });
    }

    // 任务与其前置依赖、task_repos 须原子入库：任一校验失败应整体回滚。
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await createTask(client, {
        projectId: body.projectId,
        title: body.title.trim(),
        description: body.description.trim(),
        baseBranch,
        workBranch,
        targetBranch,
        submitMode,
        autoMergePr,
        autoReply,
        autoDecisionHints,
        model,
        dynamicWorkflow,
        scheduledAt
      });
      await addTaskDependencies(client, task.id, dependsOn);
      if (taskRepoInputs) {
        await createTaskRepos(client, task.id, taskRepoInputs);
      }
      // 附件绑定：admin 可借他人上传的附件，其它角色仅能用自己上传的（owner_user_id 校验）。
      await bindAttachmentsToTask(
        client,
        task.id,
        attachmentIds,
        user.role === "admin" ? null : user.id
      );
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
    return errorResponse(error);
  }
}
