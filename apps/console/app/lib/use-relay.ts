"use client";

import type { RelayEvent } from "@claude-center/relay-client";

// 浏览器侧 SSE 中转订阅（全站共享单连接）：用原生 EventSource + 短时效 ticket。
// 收到事件即通知所有监听者（usePolling 据此额外触发一次刷新，把 ≤3s 轮询延迟降到亚秒级）。
// relay 未启用 / 连接失败时静默退回——现有轮询仍在跑，功能不降级。Phase 2 再做「健康时慢化轮询」。

interface TicketInfo {
  enabled?: boolean;
  url?: string;
  ticket?: string;
  channels?: string[];
  ttlMs?: number;
}

const listeners = new Set<(event: RelayEvent) => void>();
let started = false;
// 取到 ticket 显示 relay 未启用（或无可订阅频道）后置位，避免每次挂载都重复探测。
let disabled = false;
let source: EventSource | null = null;
let backoff = 1_000;
let reconnectTimer: number | null = null;
let rotateTimer: number | null = null;

function emit(event: RelayEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* 单个监听者抛错不影响其它 */
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) {
    return;
  }
  const wait = Math.min(backoff, 30_000);
  backoff = Math.min(backoff * 2, 30_000);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, wait);
}

async function connect(): Promise<void> {
  if (disabled) {
    return;
  }
  let info: TicketInfo;
  try {
    const res = await fetch("/api/relay/ticket", { cache: "no-store" });
    if (!res.ok) {
      scheduleReconnect();
      return;
    }
    info = (await res.json()) as TicketInfo;
  } catch {
    scheduleReconnect();
    return;
  }
  if (!info.enabled || !info.url || !info.ticket || !info.channels?.length) {
    // relay 未启用或当前用户无可订阅项目：停用，纯靠轮询，不再重试。
    disabled = true;
    return;
  }
  const url = new URL(`${info.url.replace(/\/+$/, "")}/events`);
  url.searchParams.set("channels", info.channels.join(","));
  url.searchParams.set("ticket", info.ticket);
  const es = new EventSource(url.toString());
  source = es;
  es.onopen = () => {
    backoff = 1_000;
  };
  es.onmessage = (event) => {
    try {
      emit(JSON.parse(event.data) as RelayEvent);
    } catch {
      /* 非 JSON 帧（保活）忽略 */
    }
  };
  es.onerror = () => {
    // 原生 EventSource 会自行重连，但 ticket 会过期 → 主动关掉、换新票重连。
    es.close();
    if (source === es) {
      source = null;
    }
    scheduleReconnect();
  };
  // 在 ticket 过期前主动轮换：关旧连、取新票、重连，避免过期后被 relay 拒绝陷入重连环。
  if (rotateTimer !== null) {
    window.clearTimeout(rotateTimer);
  }
  const ttl = typeof info.ttlMs === "number" ? info.ttlMs : 300_000;
  rotateTimer = window.setTimeout(() => {
    es.close();
    if (source === es) {
      source = null;
    }
    void connect();
  }, Math.max(30_000, ttl - 30_000));
}

function ensureStarted(): void {
  if (started || disabled) {
    return;
  }
  started = true;
  void connect();
}

// 注册一个事件监听者（返回注销函数）。首个监听者触发共享连接的懒启动。
export function registerRelayListener(listener: (event: RelayEvent) => void): () => void {
  listeners.add(listener);
  ensureStarted();
  return () => {
    listeners.delete(listener);
  };
}
