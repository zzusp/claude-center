import {
  getConversation,
  getPool,
  requestConversationTurnCancellation
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";
import { projectChannel, publishRelay, workerChannel } from "../../../../lib/relay-publish";

export const dynamic = "force-dynamic";

// 终止当前对话的在途 assistant 轮：打 cancel_requested_at 标记 + relay 直推 worker 频道做亚秒级触发。
// 没有在途轮（已结束/已应答）返回 409 让 UI 提示「无可终止」。Worker 收到信号后扫描自己名下被请求取消的消息，
// 杀 Claude 进程树 → 标记 cancelled → publish 终态供 Console 列表与详情同步。
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
    const message = await requestConversationTurnCancellation(getPool(), id);
    if (!message) {
      return NextResponse.json({ error: "当前没有可终止的回答" }, { status: 409 });
    }
    // 双频道发布：worker 频道直达执行该轮的 worker；project 频道给同项目的 Console 端订阅者刷新会话头。
    publishRelay({
      channel: workerChannel(conversation.worker_id),
      type: "conversation.cancel",
      entityId: id,
      projectId: conversation.project_id,
      seq: message.seq ?? undefined,
      payload: { conversationId: id, messageId: message.id }
    });
    publishRelay({
      channel: projectChannel(conversation.project_id),
      type: "conversation.message",
      entityId: id,
      projectId: conversation.project_id,
      seq: message.seq ?? undefined,
      payload: message
    });
    return NextResponse.json({ message });
  } catch (error) {
    return errorResponse(error);
  }
}
