import {
  deleteTask,
  getPool,
  getTaskProjectId,
  getTaskWithDeps,
  publishTask,
  reactivateTask,
  requestTaskCancellation,
  updateTask,
  userHasProject
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";
import type { TaskModel, TaskSubmitMode } from "@claude-center/db";

export const dynamic = "force-dynamic";

// 单任务详情：task 本体（含 project_name / depends_on / blocked）+ 前置任务标题，供独立详情页轮询。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目下的任务。
    if (user.role !== "admin") {
      const projectId = await getTaskProjectId(getPool(), id);
      if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
        return NextResponse.json({ error: "无权访问该任务" }, { status: 403 });
      }
    }
    const detail = await getTaskWithDeps(getPool(), id);
    if (!detail) {
      return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

// 任务状态切换与编辑：
// publish（草稿 → 待处理）、cancel（在途取消）、update（编辑草稿字段）、reactivate（失败/取消 → 待处理）。
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
      model?: TaskModel;
      scheduledAt?: string | null;
    };

    // 项目隔离：非 admin 只能操作分配给自己项目下的任务。
    if (user.role !== "admin") {
      const projectId = await getTaskProjectId(getPool(), id);
      if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
        return NextResponse.json({ error: "无权操作该任务" }, { status: 403 });
      }
    }

    if (body.action === "publish") {
      const task = await publishTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "任务不存在或不是草稿状态" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    if (body.action === "cancel") {
      const task = await requestTaskCancellation(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法取消：仅在途（已领取/执行中/等待中）任务可取消" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    if (body.action === "update") {
      if (!body.title || !body.description || !body.baseBranch || !body.workBranch || !body.targetBranch || !body.submitMode || !body.model) {
        return NextResponse.json({ error: "缺少必要字段" }, { status: 400 });
      }
      const task = await updateTask(getPool(), id, {
        title: body.title,
        description: body.description,
        baseBranch: body.baseBranch,
        workBranch: body.workBranch,
        targetBranch: body.targetBranch,
        submitMode: body.submitMode,
        autoMergePr: body.autoMergePr ?? false,
        model: body.model,
        scheduledAt: body.scheduledAt ?? null
      });
      if (!task) {
        return NextResponse.json({ error: "任务不存在或已开始执行，无法编辑" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    if (body.action === "reactivate") {
      const task = await reactivateTask(getPool(), id);
      if (!task) {
        return NextResponse.json({ error: "无法激活：仅失败或已取消的任务可重新激活" }, { status: 409 });
      }
      return NextResponse.json({ task });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

// 删除任务：仅限 draft / scheduled / failed / cancelled 态可删除。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    if (user.role !== "admin") {
      const projectId = await getTaskProjectId(getPool(), id);
      if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
        return NextResponse.json({ error: "无权操作该任务" }, { status: 403 });
      }
    }
    const deleted = await deleteTask(getPool(), id);
    if (!deleted) {
      return NextResponse.json({ error: "任务不存在或执行中不可删除" }, { status: 409 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
