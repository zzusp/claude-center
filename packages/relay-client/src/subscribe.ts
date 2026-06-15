import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RelayEvent } from "./events.js";

// Node 侧 SSE 订阅客户端（Worker 用；浏览器用原生 EventSource，见 console 的 use-relay）。
// 用 node:http/https 原生流，自实现：保活断线检测 + 指数退避抖动自动重连 + Last-Event-ID 续传。
// 不依赖第三方 eventsource 包，也不依赖实验性的全局 EventSource，跨 Electron/Node 版本稳。

export interface SubscribeOptions {
  // relay 基址（如 http://127.0.0.1:8787）。
  url: string;
  // 要订阅的频道（worker:<id> + 本机 project:<id>）。
  channels: string[];
  // Worker 订阅鉴权 token（CLAUDE_CENTER_RELAY_WORKER_TOKEN），走 Authorization 头。
  token?: string;
  // 浏览器式票据（Worker 不用）。
  ticket?: string;
  onEvent: (event: RelayEvent) => void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  // 超过该时长没收到任何字节（含保活 :ping）即判定断线、主动重连。默认 40s（relay 默认 15s ping）。
  pingTimeoutMs?: number;
  maxBackoffMs?: number;
}

export interface Subscription {
  close(): void;
}

export function subscribeRelay(options: SubscribeOptions): Subscription {
  const base = options.url.replace(/\/+$/, "");
  const pingTimeoutMs = options.pingTimeoutMs ?? 40_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;

  let closed = false;
  let lastEventId: string | null = null;
  let backoff = 1_000;
  let req: ClientRequest | null = null;
  let deadTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function clearDead(): void {
    if (deadTimer) {
      clearTimeout(deadTimer);
      deadTimer = null;
    }
  }

  function armDead(): void {
    clearDead();
    deadTimer = setTimeout(() => {
      // 断线检测：超时无字节 → 主动断开，触发 res 的 close/error → 重连。
      if (req) {
        req.destroy();
      }
    }, pingTimeoutMs);
  }

  function scheduleReconnect(): void {
    clearDead();
    if (closed || reconnectTimer) {
      return;
    }
    const wait = Math.min(backoff, maxBackoffMs);
    backoff = Math.min(backoff * 2, maxBackoffMs);
    const jitter = Math.floor(Math.random() * wait * 0.25);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait + jitter);
  }

  function handleFrame(raw: string): void {
    if (!raw) {
      return;
    }
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) {
        // 空行或注释（保活 :ping）——不是数据帧。
        continue;
      }
      if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // event: 字段忽略——type 已在 payload 内。
    }
    if (id) {
      lastEventId = id;
    }
    if (!dataLines.length) {
      return;
    }
    try {
      options.onEvent(JSON.parse(dataLines.join("\n")) as RelayEvent);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function connect(): void {
    if (closed) {
      return;
    }
    let url: URL;
    try {
      url = new URL(`${base}/events`);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (options.channels.length) {
      url.searchParams.set("channels", options.channels.join(","));
    }
    if (options.ticket) {
      url.searchParams.set("ticket", options.ticket);
    }
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    if (lastEventId) {
      headers["last-event-id"] = lastEventId;
    }
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    req = transport(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          scheduleReconnect();
          return;
        }
        // 连接成功：复位退避，开始保活计时。
        backoff = 1_000;
        options.onOpen?.();
        armDead();
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          armDead();
          buffer += chunk;
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            handleFrame(buffer.slice(0, idx));
            buffer = buffer.slice(idx + 2);
            idx = buffer.indexOf("\n\n");
          }
        });
        res.on("end", scheduleReconnect);
        res.on("close", scheduleReconnect);
        res.on("error", scheduleReconnect);
      }
    );
    req.on("error", (error) => {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      scheduleReconnect();
    });
    req.end();
  }

  connect();

  return {
    close(): void {
      closed = true;
      clearDead();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (req) {
        req.destroy();
      }
    }
  };
}
