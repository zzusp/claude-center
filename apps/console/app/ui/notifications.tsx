"use client";

import type { Notification, NotificationType } from "@claude-center/db";
import {
  AlertTriangle, Bell, BellRing, CheckCircle2, FileEdit, MessageCircleQuestion,
  PlugZap, ServerCrash, ServerOff, Wifi, WifiOff, XCircle
} from "lucide-react";
import Link from "next/link";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { usePolling } from "../lib/use-polling";
import { useRelayStatus, type RelayStatus } from "../lib/use-relay";
import { playNotifySound } from "../lib/notify-sound";
import { fmtAgo } from "./dashboard-shared";
import { FormModal } from "./controls";

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

// 悬浮面板只显示最新 8 条；点「查看更多」打开弹窗，弹窗首屏 10 条，
// 每点「加载更多」多查 10 条，累计上限 200 条（与后端钳制一致，防恶意大 limit）。
const HOVER_LIMIT = 8;
const MODAL_PAGE = 10;
const MODAL_MAX = 200;

// 需要声音提醒的通知类型：任务完成 / 失败 / 等待回复（与任务直接相关、用户多半在等的结果）。
// worker 上下线 / PR 已建 / 任务被领取等过程性通知不响铃，避免提示音泛滥。
const SOUND_TYPES = new Set<NotificationType>(["task_success", "task_failed", "task_waiting"]);

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
      title: "SSE 连接中断",
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

  // 弹窗状态：独立于悬浮面板的轮询，按 limit 增量翻页。
  const [modalOpen, setModalOpen] = useState(false);
  const [modalItems, setModalItems] = useState<Item[]>([]);
  const [modalLimit, setModalLimit] = useState(MODAL_PAGE);
  const [modalLoading, setModalLoading] = useState(false);

  // 声音提醒去重：记录已见过的通知 id，仅对「本次新出现 + 未读 + 属 SOUND_TYPES」的通知响铃。
  // 首次拉取只播种 seen（seeded=false→true），不为页面加载前就存在的旧通知补响。
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  const maybeChime = useCallback((list: Item[]) => {
    const seen = seenIdsRef.current;
    if (!seededRef.current) {
      for (const it of list) seen.add(it.id);
      seededRef.current = true;
      return;
    }
    let hasNew = false;
    for (const it of list) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      if (it.read_at === null && SOUND_TYPES.has(it.type)) hasNew = true;
    }
    if (hasNew) playNotifySound();
  }, []);

  const refresh = useCallback(
    async (isActive: () => boolean) => {
      try {
        const res = await fetch(`/api/notifications?limit=${HOVER_LIMIT}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { items: Item[]; unread: number };
        if (!isActive()) return;
        const list = data.items ?? [];
        maybeChime(list);
        setItems(list);
        setUnread(data.unread ?? 0);
        setDbFailures(0);
      } catch {
        if (!isActive()) return;
        setDbFailures((n) => n + 1);
      }
    },
    [maybeChime]
  );

  // 弹窗拉取：每次按当前 limit 全量重取（最多 200 条，重取成本可忽略），
  // 顺带刷新红点未读数，避免与轮询不一致。
  const loadModal = useCallback(async (limit: number) => {
    setModalLoading(true);
    try {
      const res = await fetch(`/api/notifications?limit=${limit}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { items: Item[]; unread: number };
      setModalItems(data.items ?? []);
      setUnread(data.unread ?? 0);
    } catch {
      /* 保留已加载列表，用户可重试 */
    } finally {
      setModalLoading(false);
    }
  }, []);

  // 通知非高频写入，固定 15s 轮询即可，且要的就是「稳定 15s」节奏。这里显式不订阅 relay（relay:false）：
  // relay 启用时项目频道每条事件（消息流 / worker 心跳 / 任务状态）都会触发 usePolling 快线刷新，
  // 会把通知拉取打成亚秒~数秒的不规则高频；通知不需要亚秒级实时，下一轮 15s 轮询即可补齐。
  usePolling(refresh, [], 15000, { relay: false });


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
    if (modalOpen) void loadModal(modalLimit);
  }

  function openModal() {
    setModalLimit(MODAL_PAGE);
    setModalItems([]);
    setModalOpen(true);
    void loadModal(MODAL_PAGE);
  }

  function loadMore() {
    const next = Math.min(modalLimit + MODAL_PAGE, MODAL_MAX);
    setModalLimit(next);
    void loadModal(next);
  }

  // 满页（返回数 == 请求数）说明可能还有更多；不足说明已到底；并受 200 上限封顶。
  const modalHasMore = modalItems.length >= modalLimit && modalLimit < MODAL_MAX;

  // 单条持久化通知的渲染：悬浮面板与弹窗共用，保证两处样式 / 交互一致。
  function renderItem(item: Item): ReactNode {
    const tone = toneFor(item.type);
    const isUnread = item.read_at === null;
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
        {isUnread && <span className="notif-row-dot" aria-hidden />}
      </>
    );
    const classes = `notif-row${isUnread ? " unread" : ""}`;
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
  }

  const totalDot = unread; // 瞬时通知不计入红点
  const empty = items.length === 0 && ephemerals.length === 0;

  return (
    <div className={`notif${modalOpen ? " notif-modal-open" : ""}`}>
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

            {items.map(renderItem)}

            {empty && (
              <div className="notif-empty">
                <ServerOff size={18} strokeWidth={1.5} />
                <span>暂无通知</span>
              </div>
            )}
          </div>

          {items.length > 0 && (
            <button type="button" className="notif-more" onClick={openModal}>
              查看更多
            </button>
          )}
        </div>

      <FormModal open={modalOpen} title="消息通知" onClose={() => setModalOpen(false)} size="md">
        <div className="notif-modal-bar">
          <button
            type="button"
            className="notif-mark-all"
            onClick={() => markRead()}
            disabled={unread === 0}
          >
            全部已读
          </button>
        </div>
        <div className="notif-modal-list">
          {modalItems.length > 0 ? (
            modalItems.map(renderItem)
          ) : (
            <div className="notif-empty">
              <ServerOff size={18} strokeWidth={1.5} />
              <span>{modalLoading ? "加载中…" : "暂无通知"}</span>
            </div>
          )}
        </div>
        <div className="notif-modal-foot">
          {/* 加载中优先：点「加载更多」后 modalLimit 已增、modalItems 未更新，
              modalHasMore 会瞬时变 false，故先判 loading 避免误显「没有更多了」。 */}
          {modalLoading ? (
            <span className="notif-modal-end">加载中…</span>
          ) : modalHasMore ? (
            <button type="button" className="btn btn-sm" onClick={loadMore}>
              加载更多
            </button>
          ) : (
            modalItems.length > 0 && <span className="notif-modal-end">没有更多了</span>
          )}
        </div>
      </FormModal>
    </div>
  );
}
