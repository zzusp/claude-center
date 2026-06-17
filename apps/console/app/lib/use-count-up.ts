"use client";

import { useEffect, useRef, useState } from "react";

// 数字滚动过渡：value 变化时在 ~durationMs 内 rAF 插值到目标整数值，
// 让 StatCard / KPI 之类"在跑的数据"在视觉上有活体感。
// prefers-reduced-motion 直接给目标值，不做插值。
export function useCountUp(value: number, durationMs = 480): number {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  displayRef.current = display;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || displayRef.current === value) {
      setDisplay(value);
      return;
    }
    const from = displayRef.current;
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [value, durationMs]);

  return display;
}
