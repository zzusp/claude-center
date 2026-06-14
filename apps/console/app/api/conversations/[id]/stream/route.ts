import {
  getConversation,
  getConversationChunks,
  getLatestAssistantMessage,
  getPool,
  onConversationNotice,
  userHasProject
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

// SSE 流式：把当前 assistant 轮的 token 增量逐片推给浏览器（打字机）。worker 流式时 pg_notify →
// 本端 LISTEN 扇出触发 flush，慢轮询(2s)兜底防丢；turn 结束发 done。详见 docs/spec/worker-direct-chat.md §5.2
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  const { id } = await params;
  const conversation = await getConversation(getPool(), id);
  if (!conversation) {
    return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  }
  if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, conversation.project_id))) {
    return NextResponse.json({ error: "无权访问该对话" }, { status: 403 });
  }

  const encoder = new TextEncoder();
  const sentChunk = new Map<string, number>(); // messageId -> 已转发到的最大分片 seq
  const doneSent = new Set<string>();
  let firstFlush = true;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (payload: string) => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(payload));
          } catch {
            closed = true;
          }
        }
      };
      const sse = (event: string | null, data: unknown, eventId?: string) => {
        let s = "";
        if (eventId !== undefined) s += `id: ${eventId}\n`;
        if (event) s += `event: ${event}\n`;
        s += `data: ${JSON.stringify(data)}\n\n`;
        write(s);
      };

      let flushing = false;
      const flush = async (): Promise<void> => {
        if (flushing || closed) {
          return;
        }
        flushing = true;
        try {
          const asst = await getLatestAssistantMessage(getPool(), id);
          if (!asst) {
            return;
          }
          // 连接时最近一轮已结束：客户端已从历史拿到，标记为已发、不重复推。
          if (firstFlush && (asst.status === "done" || asst.status === "failed")) {
            const chunks = await getConversationChunks(getPool(), asst.id);
            sentChunk.set(asst.id, chunks.length ? chunks[chunks.length - 1]!.seq : -1);
            doneSent.add(asst.id);
            return;
          }
          const from = sentChunk.get(asst.id) ?? -1;
          const chunks = await getConversationChunks(getPool(), asst.id, from);
          for (const ch of chunks) {
            sse("delta", { messageId: asst.id, seq: ch.seq, delta: ch.delta }, `${asst.id}:${ch.seq}`);
            sentChunk.set(asst.id, ch.seq);
          }
          if ((asst.status === "done" || asst.status === "failed") && !doneSent.has(asst.id)) {
            doneSent.add(asst.id);
            sse("done", { messageId: asst.id, status: asst.status, body: asst.body, error: asst.error_message });
          }
        } finally {
          firstFlush = false;
          flushing = false;
        }
      };

      sse("open", { conversationId: id });
      await flush();
      const unsub = await onConversationNotice(id, () => {
        void flush();
      });
      const poll = setInterval(() => void flush(), 2000);
      const ping = setInterval(() => write(`: ping\n\n`), 15000);

      const cleanup = () => {
        if (closed) {
          return;
        }
        closed = true;
        unsub();
        clearInterval(poll);
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", cleanup);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    }
  });
}
