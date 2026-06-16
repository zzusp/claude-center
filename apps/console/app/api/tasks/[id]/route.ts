import {
  deleteTask,
  getPool,
  getTaskWithDeps,
  listTaskEvents,
  publishTask,
  reactivateTask,
  requestTaskCancellation,
  requestTaskRetry,
  unpublishTask,
  updateTask
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";
import { requireTaskAccess } from "../../../lib/access";
import { errorResponse, badRequest } from "../../../lib/api";
import { projectChannel, publishRelay } from "../../../lib/relay-publish";
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
    const events = await listTaskEvents(getPool(), id);
    return NextResponse.json({ ...detail, events });
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
      scheduledAt?: string | null;
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
      const task = await updateTask(getPool(), id, {
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
        scheduledAt: body.scheduledAt ?? null
      });
      if (!task) {
        return NextResponse.json({ error: "任务不存在或已开始执行，无法编辑" }, { status: 409 });
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
