"use client";

import { useEffect, useState } from "react";
import type { RelayEvent } from "@claude-center/relay-client";

// 浏览器侧 SSE 中转订阅（全站共享单连接）：用原生 EventSource + 短时效 ticket。
// 收到事件即通知所有监听者（usePolling 据此额外触发一次刷新，把 ≤3s 轮询延迟降到亚秒级）。
// relay 未启用 / 连接失败时静默退回——现有轮询仍在跑，功能不降级。Phase 2 再做「健康时慢化轮询」。
// 连接状态对外经 registerRelayStatusListener / useRelayStatus 暴露，供顶栏指示器展示连通性。

// SSE 中转连接状态：disabled=未配置/无可订阅频道(纯轮询)；connecting=首连中(未 open 过)；
// connected=流已打开；reconnecting=曾连通后断开、退避重连中。
export type RelayStatus = "disabled" | "connecting" | "connected" | "reconnecting";

interface TicketInfo {
  enabled?: boolean;
  url?: string;
  ticket?: string;
  channels?: string[];
  ttlMs?: number;
}

const listeners = new Set<(event: RelayEvent) => void>();
const statusListeners = new Set<(status: RelayStatus) => void>();
let started = false;
// 取到 ticket 显示 relay 未启用（或无可订阅频道）后置位，避免每次挂载都重复探测。
let disabled = false;
let source: EventSource | null = null;
let backoff = 1_000;
let reconnectTimer: number | null = null;
let rotateTimer: number | null = null;
// 当前对外连接状态 + 是否曾成功 open 过（用于区分首连 connecting vs 断后 reconnecting）。
let status: RelayStatus = "connecting";
let everOpen = false;

function emit(event: RelayEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* 单个监听者抛错不影响其它 */
    }
  }
}

function setStatus(next: RelayStatus): void {
  if (status === next) {
    return;
  }
  status = next;
  for (const listener of statusListeners) {
    try {
      listener(next);
    } catch {
      /* 单个监听者抛错不影响其它 */
    }
  }
}

function scheduleReconnect(): void {
  // 取/建连失败：曾连通过 → reconnecting，否则仍是首连 connecting。
  setStatus(everOpen ? "reconnecting" : "connecting");
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
    setStatus("disabled");
    return;
  }
  const url = new URL(`${info.url.replace(/\/+$/, "")}/events`);
  url.searchParams.set("channels", info.channels.join(","));
  url.searchParams.set("ticket", info.ticket);
  const es = new EventSource(url.toString());
  source = es;
  es.onopen = () => {
    backoff = 1_000;
    everOpen = true;
    setStatus("connected");
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

// 当前 SSE 中转连接状态（同步读取）。
export function getRelayStatus(): RelayStatus {
  return status;
}

// 订阅连接状态变化（返回注销函数）；注册即触发懒启动并立即回推当前状态。
export function registerRelayStatusListener(listener: (status: RelayStatus) => void): () => void {
  statusListeners.add(listener);
  ensureStarted();
  listener(status);
  return () => {
    statusListeners.delete(listener);
  };
}

// React hook：在 client 组件中订阅 SSE 中转连接状态，用于展示连通性指示器。
export function useRelayStatus(): RelayStatus {
  const [current, setCurrent] = useState<RelayStatus>(() => getRelayStatus());
  useEffect(() => registerRelayStatusListener(setCurrent), []);
  return current;
}
