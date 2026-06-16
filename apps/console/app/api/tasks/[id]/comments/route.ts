import {
  addTaskComment,
  bindAttachmentsToComment,
  getPool,
  getTaskProjectId,
  listAttachmentsForComment,
  listTaskComments
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../../lib/session";
import { requireTaskAccess } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";
import { projectChannel, publishRelay } from "../../../../lib/relay-publish";
import { MAX_ATTACHMENTS_PER_OWNER } from "../../../../lib/attachment-config";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await requireTaskAccess(gate, id);
    if (denied) {
      return denied;
    }
    const comments = await listTaskComments(getPool(), id);
    return NextResponse.json({ comments });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.comment");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const denied = await requireTaskAccess(gate, id);
    if (denied) {
      return denied;
    }

    const body = (await request.json()) as { body?: string; attachmentIds?: string[] };
    // 评论允许"仅附件、空文本"——粘贴一张图直接回复是常见用法；body 留空字符串入库。
    const text = body.body?.trim() ?? "";
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((v): v is string => typeof v === "string")
      : [];
    if (!text && attachmentIds.length === 0) {
      return badRequest("回复内容不能为空");
    }
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_OWNER) {
      return badRequest(`附件数量超过上限（${MAX_ATTACHMENTS_PER_OWNER}）`);
    }

    // comment + 附件绑定原子化：附件绑定失败要把 comment 也回滚（否则 UI 会看到空评论加孤儿附件）。
    const client = await getPool().connect();
    let comment;
    try {
      await client.query("BEGIN");
      comment = await addTaskComment(client, {
        taskId: id,
        author: "user",
        workerId: null,
        body: text
      });
      await bindAttachmentsToComment(
        client,
        comment.id,
        attachmentIds,
        gate.role === "admin" ? null : gate.id
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // 把附件元数据合进返回的 comment，前端不必再请求一次。
    comment.attachments = await listAttachmentsForComment(getPool(), comment.id);

    // 用户回复落库后推到项目频道：waiting 任务的 Worker 收到即续接同一会话重跑。
    const projectId = await getTaskProjectId(getPool(), id);
    if (projectId) {
      publishRelay({
        channel: projectChannel(projectId),
        type: "task.comment",
        entityId: id,
        projectId,
        seq: comment.created_at,
        payload: comment
      });
    }
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
