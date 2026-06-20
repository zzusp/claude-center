import {
  deleteUnboundAttachment,
  getAttachmentBlob,
  getPool,
  getTaskProjectId,
  userHasProject
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";
import { errorResponse } from "../../../lib/api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/attachments/:id —— 下发二进制。
// 鉴权链：登录用户 → admin / 上传者本人 / 已绑定任务且该任务项目在用户范围内 /
// 已绑定评论且其所属任务项目在用户范围内 / （未绑定时仅上传者）。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const blob = await getAttachmentBlob(getPool(), id);
    if (!blob) {
      return NextResponse.json({ error: "附件不存在" }, { status: 404 });
    }
    const { meta, data } = blob;

    const allowed = await canRead(user.id, user.role, meta);
    if (!allowed) {
      return NextResponse.json({ error: "无权访问" }, { status: 403 });
    }

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": meta.mime,
        "Content-Length": String(meta.size_bytes),
        // inline 让浏览器优先内嵌预览（图片/PDF）；文件名转义防 RFC 5987 边界字符。
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.original_name)}`,
        // 内容寻址（sha256）作 ETag；浏览器 304 友好。
        ETag: `"${meta.sha256}"`,
        // 私有内容，禁止中间缓存共享。
        "Cache-Control": "private, max-age=300"
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/attachments/:id —— 仅未绑定时允许（撤销刚上传的草稿）。
// 已绑定的随 task / comment 一起级联删除，不走此接口。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const ownerScope = user.role === "admin" ? null : user.id;
    const deleted = await deleteUnboundAttachment(getPool(), id, ownerScope);
    if (!deleted) {
      return NextResponse.json(
        { error: "附件不存在、已被绑定或无权删除" },
        { status: 409 }
      );
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function canRead(
  userId: string,
  role: string,
  meta: {
    owner_user_id: string | null;
    task_id: string | null;
    task_comment_id: string | null;
    conversation_message_id: string | null;
  }
): Promise<boolean> {
  if (role === "admin") {
    return true;
  }
  if (meta.owner_user_id === userId) {
    return true;
  }
  // 已绑定任务：任务的 project 在用户范围内即可读。
  if (meta.task_id) {
    return await userHasProject(getPool(), userId, await projectOfTask(meta.task_id));
  }
  // 已绑定评论：经评论所属 task 反查 project。
  if (meta.task_comment_id) {
    const taskId = await taskOfComment(meta.task_comment_id);
    if (!taskId) {
      return false;
    }
    return await userHasProject(getPool(), userId, await projectOfTask(taskId));
  }
  // 已绑定对话消息：经消息所属 conversation 反查 project。
  if (meta.conversation_message_id) {
    const projectId = await projectOfConversationMessage(meta.conversation_message_id);
    if (!projectId) {
      return false;
    }
    return await userHasProject(getPool(), userId, projectId);
  }
  // 未绑定且非上传者本人 → 拒。
  return false;
}

async function projectOfTask(taskId: string): Promise<string> {
  return (await getTaskProjectId(getPool(), taskId)) ?? "";
}

async function taskOfComment(commentId: string): Promise<string | null> {
  const result = await getPool().query<{ task_id: string }>(
    `SELECT task_id FROM task_comments WHERE id = $1 LIMIT 1`,
    [commentId]
  );
  return result.rows[0]?.task_id ?? null;
}

async function projectOfConversationMessage(messageId: string): Promise<string | null> {
  const result = await getPool().query<{ project_id: string }>(
    `SELECT c.project_id
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1
      LIMIT 1`,
    [messageId]
  );
  return result.rows[0]?.project_id ?? null;
}
