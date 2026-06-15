"use client";

import { useEffect, type DependencyList } from "react";
import { registerRelayListener } from "./use-relay";

// 全站实时同步的统一轮询节奏。集中一处，取代散落在各组件里的 3000 魔法数。
export const POLL_INTERVAL_MS = 3000;

// 通用实时同步：挂载即跑一次 + 周期轮询（兜底）+ 叠加 SSE 中转（收到事件即额外触发一次刷新，
// 把延迟从 ≤3s 降到亚秒级）。卸载时清定时器、注销中转监听并把 isActive() 翻 false，
// 供回调丢弃卸载后才返回的请求结果。deps 变化按 useEffect 语义重建。
// relay 未启用时 registerRelayListener 为 no-op，行为退化为纯轮询。
export function usePolling(
  effect: (isActive: () => boolean) => void | Promise<void>,
  deps: DependencyList,
  intervalMs: number = POLL_INTERVAL_MS
): void {
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    void effect(isActive);
    const timer = window.setInterval(() => void effect(isActive), intervalMs);
    // 快线：中转事件到达即额外刷新一次（与轮询并存，互不影响）。
    const unregister = registerRelayListener(() => {
      if (active) {
        void effect(isActive);
      }
    });
    return () => {
      active = false;
      window.clearInterval(timer);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
