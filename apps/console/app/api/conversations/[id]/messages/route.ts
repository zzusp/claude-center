import {
  addConversationMessage,
  bindAttachmentsToConversationMessage,
  getConversation,
  getPool,
  getWorker
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";
import { projectChannel, publishRelay } from "../../../../lib/relay-publish";
import { MAX_ATTACHMENTS_PER_OWNER } from "../../../../lib/attachment-config";

export const dynamic = "force-dynamic";

// 发用户消息：插一条 role='user'，worker 下一轮 tick 据「最后一条是 user」认领并流式应答。
// 可附带 attachmentIds：把已上传的附件绑定到本条消息，Worker 落地到只读 worktree 让 Claude 读（图片走 vision）。
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const payload = (await request.json()) as { body?: string; attachmentIds?: string[] };
    // 允许「仅附件、空文本」——粘一张截图直接发问是常见用法，body 留空字符串入库。
    const text = payload.body?.trim() ?? "";
    const attachmentIds = Array.isArray(payload.attachmentIds)
      ? payload.attachmentIds.filter((v): v is string => typeof v === "string")
      : [];
    if (!text && attachmentIds.length === 0) {
      return badRequest("消息内容必填");
    }
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_OWNER) {
      return badRequest(`附件数量超过上限（${MAX_ATTACHMENTS_PER_OWNER}）`);
    }
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    if (conversation.status !== "active") {
      return badRequest("对话已结束");
    }
    // worker 离线（last_seen_at > 60s）就别让用户继续发：消息能落库但永远等不到应答，反生「为何无人回」的迷惑。
    const worker = await getWorker(getPool(), conversation.worker_id);
    if (!worker || worker.status !== "online") {
      return badRequest("worker 当前离线，无法继续对话");
    }
    // 消息 + 附件绑定原子化：绑定失败要把消息也回滚（否则会看到空消息 + 孤儿附件）。
    const client = await getPool().connect();
    let message;
    try {
      await client.query("BEGIN");
      message = await addConversationMessage(client, { conversationId: id, role: "user", body: text });
      await bindAttachmentsToConversationMessage(
        client,
        message.id,
        attachmentIds,
        user.role === "admin" ? null : user.id
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // 落库后即推到项目频道：会话的 worker 已关联该项目（创建时校验），会收到并立即认领应答。
    publishRelay({
      channel: projectChannel(conversation.project_id),
      type: "conversation.message",
      entityId: id,
      projectId: conversation.project_id,
      seq: message.seq,
      payload: message
    });
    return NextResponse.json({ message }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
