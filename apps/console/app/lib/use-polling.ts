"use client";

import { useEffect, type DependencyList } from "react";
import { registerRelayListener } from "./use-relay";

// 全站实时同步的统一轮询节奏。集中一处，取代散落在各组件里的 3000 魔法数。
export const POLL_INTERVAL_MS = 3000;

// relay 事件突发到达时的合并窗口：窗内多次事件合并为 1 次刷新。
// 取 200ms：人眼无感（仍是亚秒级），又能挡掉 worker 心跳 / 多事件同帧到达造成的并发风暴。
const RELAY_COALESCE_MS = 200;

// 通用实时同步：挂载即跑一次 + 周期轮询（兜底）+ 叠加 SSE 中转（收到事件即额外触发一次刷新，
// 把延迟从 ≤3s 降到亚秒级）。卸载时清定时器、注销中转监听并把 isActive() 翻 false，
// 供回调丢弃卸载后才返回的请求结果。deps 变化按 useEffect 语义重建。
// relay 未启用时 registerRelayListener 为 no-op，行为退化为纯轮询。
//
// 防堆积：① relay 事件 200ms 去抖合并（爆发事件 → 1 次刷新）；② inflight 锁——上次还在飞则
// 仅记录"待跑一次"，回来后再单跑一次，避免慢响应窗口里多次触发把并发请求堆叠成雪球。
//
// options.relay：是否订阅 relay 推送做快线刷新，默认 true。对于慢漂移、与消息流无关的数据
// （如 worker 套餐 usage 时间窗位移），传 false 仅靠 setInterval 兜底，避免每条消息事件都
// 顺手刷一遍无关接口。
export function usePolling(
  effect: (isActive: () => boolean) => void | Promise<void>,
  deps: DependencyList,
  intervalMs: number = POLL_INTERVAL_MS,
  options: { relay?: boolean } = {}
): void {
  const relayEnabled = options.relay ?? true;
  useEffect(() => {
    let active = true;
    let inflight = false;
    let pending = false;
    let coalesceTimer: number | null = null;
    const isActive = () => active;

    const run = async (): Promise<void> => {
      if (!active) return;
      if (inflight) {
        // 上次还没返回，记一笔"待跑"，回来时再单跑一次（多次叠加只算 1 次，天然合并）。
        pending = true;
        return;
      }
      inflight = true;
      try {
        await effect(isActive);
      } finally {
        inflight = false;
        if (active && pending) {
          pending = false;
          void run();
        }
      }
    };

    // 首次挂载立即跑一次（快速首屏）。后续刷新有两个来源：定时器 + relay 推送。
    // intervalMs 非有限正数（Infinity / NaN / <=0）视为「完全关闭自动刷新」——两个来源都不挂，
    // 只剩首次 + deps 变化触发；用于不希望被任意事件刷的下拉/列表（如任务调度页主列表与下拉数据）。
    // 注意：setInterval(fn, Infinity) 在 HTML 规范下会被钳到 ≤1ms，叠加 inflight 锁会变成"上一个回完立刻发下一个"
    // 的请求风暴；relay 监听又会让任意频道事件穿过来触发刷新——两个都得在 Infinity 时拦掉。
    void run();
    let intervalTimer: number | undefined;
    let jitterTimer: number | undefined;
    let unregister: (() => void) | undefined;
    if (Number.isFinite(intervalMs) && intervalMs > 0) {
      // 随机抖动打散多个同页面 usePolling 的同步漂移（"雷鸣羊群"），让各轮询错开触发。
      jitterTimer = window.setTimeout(() => {
        intervalTimer = window.setInterval(() => void run(), intervalMs);
      }, Math.floor(Math.random() * intervalMs));

      // 快线：relay 事件密集到达时合并到 200ms 窗口内只跑 1 次。窗内首事件起表，后续吞掉。
      // options.relay=false 时跳过订阅——慢漂移数据不需要被消息流事件叫醒。
      if (relayEnabled) {
        unregister = registerRelayListener(() => {
          if (!active || coalesceTimer !== null) return;
          coalesceTimer = window.setTimeout(() => {
            coalesceTimer = null;
            void run();
          }, RELAY_COALESCE_MS);
        });
      }
    }

    return () => {
      active = false;
      if (jitterTimer !== undefined) window.clearTimeout(jitterTimer);
      if (intervalTimer !== undefined) window.clearInterval(intervalTimer);
      if (coalesceTimer !== null) {
        window.clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      if (unregister !== undefined) unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
