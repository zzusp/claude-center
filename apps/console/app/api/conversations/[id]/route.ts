import {
  deleteConversation,
  getConversation,
  getPool,
  listConversationMessages,
  renameConversation,
  userHasProject
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../lib/session";

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
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    const messages = await listConversationMessages(getPool(), id);
    return NextResponse.json({ conversation, messages });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

// 重命名会话：复用 command.create 权限（与建/结束对话同级），按项目可见性校验。
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as { title?: string };
    const title = body.title?.trim();
    if (title == null) {
      return NextResponse.json({ error: "title 必填" }, { status: 400 });
    }
    if (title.length > 200) {
      return NextResponse.json({ error: "标题最长 200 字" }, { status: 400 });
    }
    const conversation = await getConversation(getPool(), id);
    if (!conversation) {
      return NextResponse.json({ error: "对话不存在" }, { status: 404 });
    }
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    await renameConversation(getPool(), id, title);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
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
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
      return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
    }
    await deleteConversation(getPool(), id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
