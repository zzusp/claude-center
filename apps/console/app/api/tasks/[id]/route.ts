import {
  createTaskRepos,
  deleteTask,
  deleteTaskRepos,
  getPool,
  getTaskWithDeps,
  getWorker,
  listProjectRepos,
  listTaskEvents,
  listTaskRepos,
  publishTask,
  reactivateTask,
  requestTaskCancellation,
  requestTaskRetry,
  unpublishTask,
  updateTask,
  type TaskRepoInput
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";
import { requireTaskAccess } from "../../../lib/access";
import { errorResponse, badRequest } from "../../../lib/api";
import { projectChannel, publishRelay } from "../../../lib/relay-publish";
import { buildTaskRepoInputs, type TaskRepoUserInput } from "../../../lib/task-repos-input";
import type { Task, TaskModel, TaskSubmitMode } from "@claude-center/db";

export const dynamic = "force-dynamic";

// 任务状态变更后推全量任务行到项目频道（best-effort，落库成功后调用）。
function publishTaskUpserted(task: Task): void {
  publishRelay({
    channel: projectChannel(task.project_id),
    type: "task.upserted",
    entityId: task.id,
    projectId: task.project_id,
    seq: task.updated_at,
    payload: task
  });
}

// 单任务详情聚合：task 本体（含 project_name / depends_on / blocked）+ 前置任务标题 + task_events，
// 供详情页常驻轮询一次取齐（events 与 task 同为页面常驻数据，合并省一次往返）。
// 注意：comments / session 仍是各自独立端点 + 按 tab 懒轮询，不并入这里——它们只在对应 tab
// 打开时才拉，并入会让其常驻拉取、反而更费。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下的任务。
    const denied = await requireTaskAccess(user, id);
    if (denied) {
      return denied;
    }
    const detail = await getTaskWithDeps(getPool(), id);
    if (!detail) {
      return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    }
    const [events, taskRepos, worker] = await Promise.all([
      listTaskEvents(getPool(), id),
      listTaskRepos(getPool(), id),
      // 任务详情顺路返回当前认领 worker 的 claude_version / 套餐 / 用量，供执行记录 tab 顶部
      // SessionMetaBar 展示「模型 + 套餐用量 + 通道」一行；未认领或 worker 已删则为 null。
      detail.task.claimed_by ? getWorker(getPool(), detail.task.claimed_by) : Promise.resolve(null)
    ]);
    return NextResponse.json({ ...detail, events, taskRepos, worker });
  } catch (error) {
    return errorResponse(error);
  }
}

// 任务状态切换与编辑：
// publish（草稿 → 待处理）、unpublish（待处理 → 草稿）、cancel（在途取消）、
// update（编辑草稿字段）、reactivate（失败/取消 → 草稿）、retry（失败/取消 → 续接重试,打 retry_requested_at）。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      action?: string;
      title?: string;
      description?: string;
      baseBranch?: string;
      workBranch?: string;
      targetBranch?: string;
      submitMode?: TaskSubmitMode;
      autoMergePr?: boolean;
      autoReply?: boolean;
      autoDecisionHints?: string;
      model?: TaskModel;
      dynamicWorkflow?: boolean;
      scheduledAt?: string | null;
      // 多仓任务（spec docs/spec/task-multi-repo.md）：编辑时整批替换 task_repos。
      // 缺省时按主仓单行重新生成、其它子仓 skipped（兼容旧前端）。
      taskRepos?: TaskRepoUserInput[];
    };

    // 项目隔离：非 admin 只能操作分配给自己项目下的任务。
    const denied = await requireTaskAccess(user, id, "无权操作该任务");
    if (denied) {
      return denied;
    }

    if (body.action === "publish") {
      const task = await publishTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "任务不存在或不是草稿状态" }, { status: 409 });
      }
      publishTaskUpserted(task);
      return NextResponse.json({ task });
    }

    if (body.action === "cancel") {
      const task = await requestTaskCancellation(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法取消：仅在途（已领取/执行中/等待中）任务可取消" }, { status: 409 });
      }
      publishTaskUpserted(task);
      return NextResponse.json({ task });
    }

    if (body.action === "update") {
      if (!body.title || !body.description || !body.baseBranch || !body.workBranch || !body.targetBranch || !body.submitMode || !body.model) {
        return badRequest("缺少必要字段");
      }
      const autoReply = body.autoReply === true;
      // 多仓任务：在同事务里 updateTask + 整批替换 task_repos。先取项目仓清单再生成新 inputs。
      const client = await getPool().connect();
      let task: Task | null = null;
      try {
        await client.query("BEGIN");
        task = await updateTask(client, id, {
          title: body.title,
          description: body.description,
          baseBranch: body.baseBranch,
          workBranch: body.workBranch,
          targetBranch: body.targetBranch,
          submitMode: body.submitMode,
          autoMergePr: body.autoMergePr ?? false,
          autoReply,
          autoDecisionHints: autoReply ? (body.autoDecisionHints ?? "").trim() : "",
          model: body.model,
          dynamicWorkflow: body.dynamicWorkflow === true,
          scheduledAt: body.scheduledAt ?? null
        });
        if (!task) {
          await client.query("ROLLBACK");
          return NextResponse.json({ error: "任务不存在或已开始执行，无法编辑" }, { status: 409 });
        }
        // task_repos 处理策略：
        // - body.taskRepos 显式数组 → 整批替换（用户在 UI 上编辑过多仓配置）
        // - body.taskRepos === undefined → 仅同步主仓行的 base/work/target（保留子仓配置不动）
        // 这样编辑表单（暂不带多仓 UI）保存时不会把子仓配置全清成 skipped。
        if (Array.isArray(body.taskRepos)) {
          const projectRepos = await listProjectRepos(client, task.project_id);
          const taskRepoInputs = buildTaskRepoInputs({
            projectRepos,
            body,
            baseBranch: body.baseBranch,
            workBranch: body.workBranch,
            targetBranch: body.targetBranch
          });
          await deleteTaskRepos(client, task.id);
          await createTaskRepos(client, task.id, taskRepoInputs);
        } else {
          // 仅同步主仓行（task 表 base/work/target 是主仓镜像，task_repos main 行必须保持一致）
          await client.query(
            `UPDATE task_repos
                SET base_branch = $2,
                    work_branch = $3,
                    target_branch = $4,
                    updated_at = now()
              WHERE task_id = $1 AND role = 'main'`,
            [task.id, body.baseBranch, body.workBranch, body.targetBranch]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      publishTaskUpserted(task);
      return NextResponse.json({ task });
    }

    if (body.action === "reactivate") {
      const task = await reactivateTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法激活：仅失败或已取消的任务可重新激活" }, { status: 409 });
      }
      publishTaskUpserted(task);
      return NextResponse.json({ task });
    }

    if (body.action === "retry") {
      const task = await requestTaskRetry(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法重试：仅失败或已取消的任务可续接重试" }, { status: 409 });
      }
      publishTaskUpserted(task);
      return NextResponse.json({ task });
    }

    if (body.action === "unpublish") {
      const task = await unpublishTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法退回：仅待处理任务可退回草稿" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    return badRequest("Unsupported action");
  } catch (error) {
    return errorResponse(error);
  }
}

// 删除任务：仅「已认领 / 执行中」在途态禁止删除，其余状态均可删除。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const denied = await requireTaskAccess(user, id, "无权操作该任务");
    if (denied) {
      return denied;
    }
    const deleted = await deleteTask(getPool(), id);
    if (!deleted) {
      return NextResponse.json({ error: "任务不存在，或已认领/执行中不可删除" }, { status: 409 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
