"use client";

import type { Notification, NotificationType } from "@claude-center/db";
import {
  AlertTriangle, Bell, BellRing, CheckCircle2, FileEdit, MessageCircleQuestion,
  PlugZap, ServerCrash, ServerOff, Wifi, WifiOff, XCircle
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { usePolling } from "../lib/use-polling";
import { useRelayStatus, type RelayStatus } from "../lib/use-relay";
import { fmtAgo } from "./dashboard-shared";

// 顶栏「铃铛」消息中心：聚合 9 类通知。
//
// 持久化部分（7 种，来自 DB notifications 表）：
//   task_claimed / task_waiting / task_success / task_failed / task_pr_created /
//   worker_online / worker_offline
//
// 瞬时部分（2 种，前端合成、不入 DB）：
//   sse_disconnect：useRelayStatus 监到 disabled / reconnecting 持续 ≥5s 时合成一条；恢复后自动撤
//   db_disconnect：通知接口本身 fetch 失败累计 ≥2 次时合成一条；恢复后自动撤
// 两类瞬时通知不计入 unread 红点（无法持久化为「已读」），仅在下拉里展示当前健康状况，避免红点常亮。

type Item = Notification;

// 前端合成的瞬时类型——加在原 NotificationType 之外，仅在 UI 内部使用。
type EphemeralType = "sse_disconnect" | "db_disconnect";
type AnyType = NotificationType | EphemeralType;

type EphemeralItem = {
  id: string; // 固定字符串，复用 React key
  type: EphemeralType;
  title: string;
  body: string;
};

const TYPE_LABEL: Record<AnyType, string> = {
  task_claimed: "任务被领取",
  task_waiting: "任务等待回复",
  task_success: "任务完成",
  task_failed: "任务失败",
  task_pr_created: "PR 已建",
  worker_online: "Worker 上线",
  worker_offline: "Worker 下线",
  sse_disconnect: "SSE 中断",
  db_disconnect: "数据库中断"
};

function iconFor(type: AnyType): ReactNode {
  const size = 16;
  switch (type) {
    case "task_claimed":
      return <FileEdit size={size} strokeWidth={1.6} />;
    case "task_waiting":
      return <MessageCircleQuestion size={size} strokeWidth={1.6} />;
    case "task_success":
      return <CheckCircle2 size={size} strokeWidth={1.6} />;
    case "task_failed":
      return <XCircle size={size} strokeWidth={1.6} />;
    case "task_pr_created":
      return <PlugZap size={size} strokeWidth={1.6} />;
    case "worker_online":
      return <Wifi size={size} strokeWidth={1.6} />;
    case "worker_offline":
      return <WifiOff size={size} strokeWidth={1.6} />;
    case "sse_disconnect":
      return <AlertTriangle size={size} strokeWidth={1.6} />;
    case "db_disconnect":
      return <ServerCrash size={size} strokeWidth={1.6} />;
    default:
      return <Bell size={size} strokeWidth={1.6} />;
  }
}

function toneFor(type: AnyType): string {
  switch (type) {
    case "task_failed":
    case "worker_offline":
    case "sse_disconnect":
    case "db_disconnect":
      return "failed";
    case "task_success":
    case "worker_online":
      return "success";
    case "task_pr_created":
      return "merged";
    case "task_waiting":
      return "waiting";
    case "task_claimed":
      return "running";
    default:
      return "pending";
  }
}

// SSE 状态合成成瞬时通知：reconnecting 出现立刻挂上；disabled 仅当用户曾配置过 relay 时才挂（不做配置探测，保守跳过）。
function ephemeralFromRelay(status: RelayStatus): EphemeralItem | null {
  if (status === "reconnecting") {
    return {
      id: "ephemeral:sse",
      type: "sse_disconnect",
      title: "SSE 实时通道中断",
      body: "正在重连。数据同步已退回数据库轮询，功能不降级。"
    };
  }
  return null;
}

export default function Notifications() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [dbFailures, setDbFailures] = useState(0);
  const relayStatus = useRelayStatus();

  // 关心 disabled 状态：用户没配 relay 时 disabled 永远是「就该如此」，不需要冒红。
  // 这里仅当 reconnecting 才合成，见 ephemeralFromRelay。
  const ephemerals: EphemeralItem[] = [];
  const sseEphem = ephemeralFromRelay(relayStatus);
  if (sseEphem) ephemerals.push(sseEphem);
  if (dbFailures >= 2) {
    ephemerals.push({
      id: "ephemeral:db",
      type: "db_disconnect",
      title: "数据库连接异常",
      body: "Console 已连续多次拉取通知失败，请检查数据库连通性。"
    });
  }

  const refresh = useCallback(async (isActive: () => boolean) => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { items: Item[]; unread: number };
      if (!isActive()) return;
      setItems(data.items ?? []);
      setUnread(data.unread ?? 0);
      setDbFailures(0);
    } catch {
      if (!isActive()) return;
      setDbFailures((n) => n + 1);
    }
  }, []);

  // 通知非高频写入，5s 轮询足够；relay 推送时会顺带触发额外刷新（usePolling 默认订阅）。
  usePolling(refresh, [], 5000);


  async function markRead(id?: string) {
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {})
      });
    } catch {
      /* 静默：下次轮询会修正 */
    }
    void refresh(() => true);
  }

  const totalDot = unread; // 瞬时通知不计入红点
  const empty = items.length === 0 && ephemerals.length === 0;

  return (
    <div className="notif">
      <button
        type="button"
        className="notif-trigger"
        aria-label={`消息通知（${totalDot} 条未读）`}
      >
        {totalDot > 0 ? <BellRing size={18} strokeWidth={1.6} /> : <Bell size={18} strokeWidth={1.6} />}
        {totalDot > 0 && (
          <span className="notif-dot" aria-hidden>
            {totalDot > 99 ? "99+" : totalDot}
          </span>
        )}
      </button>

      <div className="notif-panel" role="dialog" aria-label="消息通知">
          <header className="notif-head">
            <span className="notif-title">消息通知</span>
            <button
              type="button"
              className="notif-mark-all"
              onClick={() => markRead()}
              disabled={unread === 0}
            >
              全部已读
            </button>
          </header>

          <div className="notif-list">
            {ephemerals.map((item) => (
              <div className="notif-row notif-ephem" key={item.id} data-tone={toneFor(item.type)}>
                <span className="notif-ico">{iconFor(item.type)}</span>
                <div className="notif-body">
                  <div className="notif-row-title">{item.title}</div>
                  <div className="notif-row-body">{item.body}</div>
                  <div className="notif-row-meta">{TYPE_LABEL[item.type]} · 当前状态</div>
                </div>
              </div>
            ))}

            {items.map((item) => {
              const tone = toneFor(item.type);
              const unread = item.read_at === null;
              const inner = (
                <>
                  <span className="notif-ico">{iconFor(item.type)}</span>
                  <div className="notif-body">
                    <div className="notif-row-title">{item.title}</div>
                    {item.body && <div className="notif-row-body">{item.body}</div>}
                    <div className="notif-row-meta">
                      {TYPE_LABEL[item.type]} · {fmtAgo(item.created_at)}
                    </div>
                  </div>
                  {unread && <span className="notif-row-dot" aria-hidden />}
                </>
              );
              const classes = `notif-row${unread ? " unread" : ""}`;
              if (item.link) {
                const external = item.link.startsWith("http://") || item.link.startsWith("https://");
                if (external) {
                  return (
                    <a
                      key={item.id}
                      className={classes}
                      data-tone={tone}
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => void markRead(item.id)}
                    >
                      {inner}
                    </a>
                  );
                }
                return (
                  <Link
                    key={item.id}
                    className={classes}
                    data-tone={tone}
                    href={item.link}
                    onClick={() => void markRead(item.id)}
                  >
                    {inner}
                  </Link>
                );
              }
              return (
                <button
                  key={item.id}
                  type="button"
                  className={classes}
                  data-tone={tone}
                  onClick={() => void markRead(item.id)}
                >
                  {inner}
                </button>
              );
            })}

            {empty && (
              <div className="notif-empty">
                <ServerOff size={18} strokeWidth={1.5} />
                <span>暂无通知</span>
              </div>
            )}
          </div>
        </div>
    </div>
  );
}
