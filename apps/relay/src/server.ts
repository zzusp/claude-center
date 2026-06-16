import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { verifyTicket, type RelayEvent, type RelayPublish } from "@claude-center/relay-client";
import type { RelayConfig } from "./config.js";

// 单实例内存 pub/sub 的 SSE 中转。四个端点：
//   GET  /events      订阅（ticket 或 worker token 鉴权，保活 ping，Last-Event-ID 短重放）
//   POST /publish     发布（publish token 鉴权，落 ring + 扇出）
//   GET  /healthz     健康（聚合计数，无鉴权）
//   GET  /connections 当前连接明细（publish token 鉴权，admin 用于诊断）
// 权威数据在 DB，relay 只搬运已落库的事件；丢事件靠订阅端重连后的 DB 全量对账自愈。

type ClientSource = "worker" | "ticket";

interface Client {
  id: number;
  res: ServerResponse;
  channels: Set<string>;
  ping: NodeJS.Timeout;
  source: ClientSource;
  connectedAt: number;
  lastEventId?: string;
}

export interface RelayConnectionInfo {
  id: number;
  source: ClientSource;
  channels: string[];
  connectedAt: number;
  lastEventId?: string;
}

export interface RelayServerHandle {
  server: Server;
  stats(): { uptimeMs: number; channels: number; clients: number; events: number };
  connections(): { uptimeMs: number; eventSeq: number; clients: RelayConnectionInfo[] };
}

function safeEqual(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createRelayServer(config: RelayConfig): RelayServerHandle {
  // channel -> 订阅者集合
  const subscribers = new Map<string, Set<Client>>();
  // 所有活动连接（精确统计 + 关停时统一清理）。
  const allClients = new Set<Client>();
  // channel -> 最近事件环（Last-Event-ID 重放）
  const rings = new Map<string, RelayEvent[]>();
  let eventSeq = 0;
  let clientSeq = 0;
  const startedAt = Date.now();

  function addToChannel(channel: string, client: Client): void {
    let set = subscribers.get(channel);
    if (!set) {
      set = new Set();
      subscribers.set(channel, set);
    }
    set.add(client);
  }

  function removeClient(client: Client): void {
    clearInterval(client.ping);
    allClients.delete(client);
    for (const channel of client.channels) {
      const set = subscribers.get(channel);
      if (set) {
        set.delete(client);
        if (!set.size) {
          subscribers.delete(channel);
        }
      }
    }
  }

  function pushRing(event: RelayEvent): void {
    let ring = rings.get(event.channel);
    if (!ring) {
      ring = [];
      rings.set(event.channel, ring);
    }
    ring.push(event);
    if (ring.length > config.ringSize) {
      ring.splice(0, ring.length - config.ringSize);
    }
  }

  function writeEvent(res: ServerResponse, event: RelayEvent): void {
    // 不写 SSE 的 `event:` 命名字段：让浏览器原生 EventSource 的 onmessage 收到所有事件
    // （命名事件不会触发 onmessage）。事件类型已在 data 的 payload 里（event.type）。
    res.write(`id: ${event.id}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  function fanout(event: RelayEvent): number {
    const set = subscribers.get(event.channel);
    if (!set) {
      return 0;
    }
    let delivered = 0;
    for (const client of set) {
      try {
        writeEvent(client.res, event);
        client.lastEventId = event.id;
        delivered += 1;
      } catch {
        // 写失败的连接由其 close 事件清理，这里不处理。
      }
    }
    return delivered;
  }

  // 订阅鉴权：worker token（信任其请求的频道）或浏览器票据（只放行票据白名单内的频道）。
  // 返回 { channels, source } 或 null（鉴权失败）。
  function authorizeChannels(
    req: IncomingMessage,
    url: URL,
    requested: string[]
  ): { channels: string[]; source: ClientSource } | null {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (config.workerToken && safeEqual(bearer, config.workerToken)) {
      return { channels: requested, source: "worker" };
    }
    const ticket = url.searchParams.get("ticket");
    if (ticket && config.secret) {
      const payload = verifyTicket(ticket, config.secret, Date.now());
      if (!payload) {
        return null;
      }
      const allowed = new Set(payload.channels);
      return { channels: requested.filter((channel) => allowed.has(channel)), source: "ticket" };
    }
    return null;
  }

  function replay(client: Client, lastId: string): void {
    const last = Number(lastId);
    if (!Number.isFinite(last)) {
      return;
    }
    const pending: RelayEvent[] = [];
    for (const channel of client.channels) {
      const ring = rings.get(channel);
      if (!ring) {
        continue;
      }
      for (const event of ring) {
        if (Number(event.id) > last) {
          pending.push(event);
        }
      }
    }
    pending.sort((a, b) => Number(a.id) - Number(b.id));
    for (const event of pending) {
      writeEvent(client.res, event);
      client.lastEventId = event.id;
    }
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const requested = (url.searchParams.get("channels") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const authorized = authorizeChannels(req, url, requested);
    if (authorized === null) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    const { channels, source } = authorized;
    if (!channels.length) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("no permitted channels");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    // 客户端重连提示（浏览器原生 EventSource 会读取 retry）。
    res.write("retry: 3000\n\n");

    const lastEventId = (req.headers["last-event-id"] as string | undefined) ?? url.searchParams.get("lastEventId") ?? undefined;
    const client: Client = {
      id: ++clientSeq,
      res,
      channels: new Set(channels),
      ping: setInterval(() => {
        try {
          res.write(":ping\n\n");
        } catch {
          // 写失败说明连接已断，close 事件会清理。
        }
      }, config.pingIntervalMs),
      source,
      connectedAt: Date.now(),
      lastEventId
    };
    allClients.add(client);
    for (const channel of channels) {
      addToChannel(channel, client);
    }

    if (lastEventId) {
      replay(client, lastEventId);
    }

    req.on("close", () => removeClient(client));
  }

  async function handlePublish(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers["authorization"];
    const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!safeEqual(bearer, config.publishToken)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    let input: RelayPublish;
    try {
      const body = await readBody(req, config.maxBodyBytes);
      input = JSON.parse(body) as RelayPublish;
    } catch (error) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(error instanceof Error ? error.message : "bad request");
      return;
    }
    if (!input || typeof input.channel !== "string" || typeof input.type !== "string" || typeof input.entityId !== "string") {
      res.writeHead(422, { "content-type": "text/plain" });
      res.end("channel, type, entityId required");
      return;
    }
    const event: RelayEvent = {
      id: String(++eventSeq),
      channel: input.channel,
      type: input.type,
      ts: Date.now(),
      entityId: input.entityId,
      projectId: input.projectId,
      seq: input.seq,
      origin: input.origin,
      payload: input.payload
    };
    pushRing(event);
    const delivered = fanout(event);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: event.id, delivered }));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handle.stats()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/connections") {
      const auth = req.headers["authorization"];
      const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!safeEqual(bearer, config.publishToken)) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handle.connections()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      handleEvents(req, res, url);
      return;
    }
    if (req.method === "POST" && url.pathname === "/publish") {
      void handlePublish(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("internal error");
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  const handle: RelayServerHandle = {
    server,
    stats() {
      return {
        uptimeMs: Date.now() - startedAt,
        channels: subscribers.size,
        clients: allClients.size,
        events: eventSeq
      };
    },
    connections() {
      const clients: RelayConnectionInfo[] = [];
      for (const client of allClients) {
        const info: RelayConnectionInfo = {
          id: client.id,
          source: client.source,
          channels: [...client.channels],
          connectedAt: client.connectedAt
        };
        if (client.lastEventId !== undefined) {
          info.lastEventId = client.lastEventId;
        }
        clients.push(info);
      }
      clients.sort((a, b) => a.id - b.id);
      return {
        uptimeMs: Date.now() - startedAt,
        eventSeq,
        clients
      };
    }
  };

  return handle;
}
