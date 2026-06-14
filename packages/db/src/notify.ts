import { EventEmitter } from "node:events";
import pg from "pg";
import { getDatabaseUrl } from "./client.js";

// 实时对话的跨实例通知：单条专用 pg 连接 LISTEN cc_conversation（worker 流式时 pg_notify 广播到所有
// console 实例），进程内 EventEmitter 按 conversationId 扇出给各 SSE 连接。详见 docs/spec/worker-direct-chat.md §5.2

export type ConversationNotice = { conversationId: string; messageId: string; seq: number };

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 每个 SSE 连接一个 listener，不限上限

let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function ensureListener(): Promise<void> {
  if (client) {
    return;
  }
  if (!connecting) {
    connecting = (async () => {
      const c = new pg.Client({ connectionString: getDatabaseUrl() });
      c.on("notification", (msg) => {
        if (msg.channel !== "cc_conversation" || !msg.payload) {
          return;
        }
        try {
          const notice = JSON.parse(msg.payload) as ConversationNotice;
          emitter.emit(notice.conversationId, notice);
        } catch {
          // 忽略非法 payload
        }
      });
      // 连接断开：清空句柄，下次 subscribe 时重连（活跃 SSE 由各自慢轮询兜底不丢数据）。
      const reset = () => {
        if (client === c) client = null;
      };
      c.on("error", reset);
      c.on("end", reset);
      await c.connect();
      await c.query("LISTEN cc_conversation");
      client = c;
    })().finally(() => {
      connecting = null;
    });
  }
  await connecting;
}

// 订阅某会话的分片通知，返回取消函数。SSE 端点用。
export async function onConversationNotice(
  conversationId: string,
  listener: (notice: ConversationNotice) => void
): Promise<() => void> {
  await ensureListener();
  emitter.on(conversationId, listener);
  return () => emitter.off(conversationId, listener);
}
