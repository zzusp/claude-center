"use client";

import { useEffect, type DependencyList } from "react";

// 全站实时同步的统一轮询节奏。集中一处，取代散落在各组件里的 3000 魔法数。
export const POLL_INTERVAL_MS = 3000;

// 通用轮询：挂载即跑一次 + 周期跑，卸载时清定时器并把 isActive() 翻 false，
// 供回调丢弃卸载后才返回的请求结果。deps 变化按 useEffect 语义重建定时器。
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
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
