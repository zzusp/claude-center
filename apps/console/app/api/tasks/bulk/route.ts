import {
  acceptTask,
  deleteTask,
  getPool,
  getTaskProjectId,
  publishTask,
  reactivateTask,
  requestTaskCancellation,
  requestTaskRetry,
  unpublishTask,
  userHasProject
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import type { Task } from "@claude-center/db";
import { requirePermission } from "../../../lib/session";
import { errorResponse, badRequest } from "../../../lib/api";
import { projectChannel, publishRelay } from "../../../lib/relay-publish";

export const dynamic = "force-dynamic";

// 任务调度批量管理：单端点承接「批量发布 / 退回草稿 / 取消 / 验收通过 / 重新激活 / 续接重试 / 删除」。
// 入参 { action, ids[] }，逐条复用单任务 helper，按项目隔离守卫——失败逐条聚合（非整体回滚），
// UI 据 { ok, failed[] } 提示部分成功。落库即时 best-effort 推 relay，与单任务端点一致。

type BulkAction =
  | "publish"
  | "unpublish"
  | "cancel"
  | "accept"
  | "reactivate"
  | "retry"
  | "delete";

const BULK_ACTIONS: readonly BulkAction[] = [
  "publish",
  "unpublish",
  "cancel",
  "accept",
  "reactivate",
  "retry",
  "delete"
];

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

// 单任务执行：返回 { ok: true, task } 或 { ok: false, error }。
// 状态守卫一律落到 helper 的 WHERE/校验里；未命中即对应 409 文案。
async function runAction(
  action: BulkAction,
  id: string
): Promise<{ ok: true; task: Task | null } | { ok: false; error: string }> {
  const pool = getPool();
  if (action === "delete") {
    const deleted = await deleteTask(pool, id);
    return deleted
      ? { ok: true, task: null }
      : { ok: false, error: "已认领/执行中不可删除，或任务不存在" };
  }

  if (action === "accept") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const task = await acceptTask(client, id);
      if (!task) {
        await client.query("ROLLBACK");
        return { ok: false, error: "仅已完成/已合并任务可验收通过" };
      }
      await client.query("COMMIT");
      return { ok: true, task };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  const map: Record<Exclude<BulkAction, "delete" | "accept">, {
    fn: typeof publishTask;
    error: string;
  }> = {
    publish: { fn: publishTask, error: "仅草稿/定时待发任务可发布" },
    unpublish: { fn: unpublishTask, error: "仅待处理任务可退回草稿" },
    cancel: { fn: requestTaskCancellation, error: "仅在途任务可取消" },
    reactivate: { fn: reactivateTask, error: "仅失败/已取消任务可激活" },
    retry: { fn: requestTaskRetry, error: "仅失败/已取消任务可重试" }
  };
  const entry = map[action];
  const task = await entry.fn(pool, id);
  return task ? { ok: true, task } : { ok: false, error: entry.error };
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const body = (await request.json()) as { action?: string; ids?: unknown };
    const action = body.action;
    if (typeof action !== "string" || !(BULK_ACTIONS as readonly string[]).includes(action)) {
      return badRequest("不支持的批量操作");
    }
    if (!Array.isArray(body.ids)) {
      return badRequest("ids 必须为数组");
    }
    const ids = Array.from(
      new Set(body.ids.filter((id): id is string => typeof id === "string" && id.length > 0))
    );
    if (ids.length === 0) {
      return badRequest("未选择任务");
    }
    if (ids.length > 200) {
      return badRequest("一次最多操作 200 个任务");
    }

    const pool = getPool();
    const failed: { id: string; error: string }[] = [];
    let okCount = 0;

    for (const id of ids) {
      // 项目隔离：非 admin 仅能操作分配给自己项目下的任务。逐条校验，无权直接计入 failed。
      if (user.role !== "admin") {
        const projectId = await getTaskProjectId(pool, id);
        if (!projectId || !(await userHasProject(pool, user.id, projectId))) {
          failed.push({ id, error: "无权操作该任务" });
          continue;
        }
      }
      try {
        const result = await runAction(action as BulkAction, id);
        if (result.ok) {
          okCount += 1;
          if (result.task) {
            publishTaskUpserted(result.task);
          }
        } else {
          failed.push({ id, error: result.error });
        }
      } catch (error) {
        failed.push({
          id,
          error: error instanceof Error ? error.message : "未知错误"
        });
      }
    }

    return NextResponse.json({ ok: okCount, failed });
  } catch (error) {
    return errorResponse(error);
  }
}
