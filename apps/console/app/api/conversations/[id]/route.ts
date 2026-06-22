import {
  deleteConversation,
  getConversation,
  getPool,
  getWorker,
  listConversationMessages,
  renameConversation,
  updateConversationSettings
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";
import { requireProjectScope } from "../../../lib/access";
import { errorResponse, badRequest } from "../../../lib/api";

export const dynamic = "force-dynamic";

// 对话详情 + 历史消息。富展示（含工具调用 / 思考）走 /api/conversations/[id]/session 的 jsonl transcript。
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    const [messages, worker] = await Promise.all([
      listConversationMessages(getPool(), id),
      getWorker(getPool(), conversation.worker_id)
    ]);
    return NextResponse.json({ conversation, messages, worker });
  } catch (error) {
    return errorResponse(error);
  }
}

// 更新会话：重命名（title）/ 会话级设置（autoReply + autoDecisionHints）。复用 command.create 权限
//（与建/结束对话同级），按项目可见性校验。三者可单独或组合传入；均未传则报错。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      title?: string;
      autoReply?: boolean;
      autoDecisionHints?: string;
    };
    const title = body.title?.trim();
    const hasTitle = title != null;
    const hasSettings = body.autoReply !== undefined || body.autoDecisionHints !== undefined;
    if (!hasTitle && !hasSettings) {
      return badRequest("无可更新字段");
    }
    if (hasTitle && title!.length > 200) {
      return badRequest("标题最长 200 字");
    }
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    if (hasTitle) {
      await renameConversation(getPool(), id, title!);
    }
    if (hasSettings) {
      await updateConversationSettings(getPool(), id, {
        autoReply: body.autoReply,
        autoDecisionHints: body.autoDecisionHints
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// 删除会话：复用 command.create 权限（与建/结束/改名同级），按项目可见性校验。
// 消息与 session jsonl 经外键级联删除。
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    const denied = await requireProjectScope(user, conversation.project_id, "无权访问该对话");
    if (denied) {
      return denied;
    }
    await deleteConversation(getPool(), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
