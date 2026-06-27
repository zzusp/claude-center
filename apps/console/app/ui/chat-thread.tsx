"use client";

import type { AttachmentMeta, Conversation, ConversationMessage, Project, Worker } from "@claude-center/db";
import { AlertTriangle, ArrowUp, Bot, CalendarClock, Check, ChevronLeft, Clock, GitBranch, Info, MessageSquare, MoreHorizontal, Pencil, Server, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty, fmtDateTime, postJson } from "./shared";
import { AttachmentChip, AttachmentList, AttachmentUploader } from "./attachment-uploader";
import { DateTimePicker, Select, useConfirm } from "./controls";
import { SessionMetaBar } from "./session-meta";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";

// 乐观气泡：发送后到 worker 把该轮写进 jsonl transcript 之间有延迟窗，先本地显示文本 + 附件。
type PendingMsg = { text: string; attachments: AttachmentMeta[] };

// 模块级 jsonl 缓存：跨 ChatThread 卸载/重挂保留，切换回老会话时立即出内容（无空白等待）。
// 仅进程内有效（刷新页面重建）；不进 sessionStorage 是因为单 jsonl 可达 MB 级、storage 配额有限。
// 不限制条数：典型一天打开 <50 个会话，单进程 MB 级可接受；如未来确实膨胀再加 LRU。
const jsonlCache = new Map<string, { jsonl: string | null; etag: string | null }>();

// 对话消息线（右侧）+ 新建对话面板（模态）。从 chat.tsx 抽出；ChatView 仍管会话列表与编排。
export function ChatThread({
  conversation,
  canCommand,
  onChanged,
  onBack
}: {
  conversation: Conversation;
  canCommand: boolean;
  onChanged: () => void;
  // 移动端主从切换：返回会话列表（桌面端不渲染，由 CSS 隐藏）。
  onBack?: () => void;
}) {
  const [jsonl, setJsonl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<PendingMsg[]>([]);
  const [input, setInput] = useState("");
  // 待发送附件（已上传、未绑定）。send 时把 id 一并 POST、绑定到本条 user 消息。
  const [draftAtts, setDraftAtts] = useState<AttachmentMeta[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(conversation.title);
  // 顶部 SessionMetaBar 用：worker 的 claude_version / subscription / usage 由 /api/conversations/[id] 顺路返回。
  // 单连同长度仅 worker 一项变化（5h/7d 利用率 + 重置时间随时间漂移），3s 节奏太重，复用 usePolling 默认间隔即可。
  const [worker, setWorker] = useState<Worker | null>(null);
  // 移动端：会话信息条（通道/模型/套餐用量/上下文）默认折叠，点头部 ⓘ 展开；桌面端 CSS 始终展示、忽略此态。
  const [metaOpen, setMetaOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // 待发送的定时消息（status='scheduled'）：在输入框上方展示 + 可取消。随 worker 轮询一并刷新。
  const [scheduled, setScheduled] = useState<ConversationMessage[]>([]);
  // DB 里的全量消息：用于「jsonl 尚未收录 / claude 失败」时仍能显示用户气泡 + 失败状态。
  // 切页面回来后 pending 已清，此列表持久（来自服务端轮询），保证消息不消失。
  const [dbMessages, setDbMessages] = useState<ConversationMessage[]>([]);
  // 定时发送时间（composer 用，datetime-local 格式 "YYYY-MM-DDTHH:MM"）；空 = 立即发送。
  const [scheduleAt, setScheduleAt] = useState("");
  // 会话设置弹窗（自动回复 + 决策预案）开关。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const id = conversation.id;
  const { confirm, dialog: confirmDialog } = useConfirm();

  // 会话切换 / 标题被外部刷新时，重置改名草稿与编辑态。
  useEffect(() => {
    setTitleDraft(conversation.title);
    setEditingTitle(false);
  }, [conversation.title, id]);

  // 切换会话：worker 元信息清空等下个 polling 周期重新填充；jsonl 优先从缓存预填，避免空白等待
  // —— 后台轮询命中 304 / 内容未变即不动 UI，命中 200 + 新内容时再 setJsonl。
  useEffect(() => {
    const cached = jsonlCache.get(id);
    setJsonl(cached?.jsonl ?? null);
    setLoaded(cached !== undefined);
    setPending([]);
    setWorker(null);
    setScheduled([]);
    setDbMessages([]);
    setScheduleAt("");
    doneRef.current = false;
  }, [id]);

  // 拉对话详情：worker 快照（claude_version / subscription / usage）+ 全量消息（用于 jsonl 兜底渲染与定时清单）。
  // 抽成可复用函数，定时发送 / 取消 / 发送成功后手动调一次即时刷新，无需等下个轮询周期。
  const refreshMeta = useCallback(
    async (isActive: () => boolean = () => true): Promise<void> => {
      try {
        const r = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { worker: Worker | null; messages?: ConversationMessage[] };
        if (!isActive()) return;
        setWorker(d.worker);
        const all = d.messages ?? [];
        setDbMessages(all);
        setScheduled(all.filter((m) => m.status === "scheduled"));
      } catch {
        /* 轮询失败静默 */
      }
    },
    [id]
  );

  // 轮询对话详情：消息流轻量、与 jsonl 同节奏 3s。
  // 原 15s 节奏导致 jsonl 未收录新 user 消息时窗口被拉长（切回页面 / claude 失败时无气泡可显）；
  // 同节奏避免「pending 清掉了、db 还没来」的空白窗。worker 套餐用量随之刷新，可接受的小代价。
  usePolling(refreshMeta, [id], 3_000, { relay: false });

  // 轮询对话 session transcript（active 持续；closed 取一次即停）。Worker 周期 3s + 终态把 jsonl 同步到库。
  // 带 If-None-Match 条件请求：未变返 304，省下大 blob 反序列化 + setJsonl 触发的整棵 reconcile；
  // 即便 200 回来内容字符串相等也保留旧引用，避免 useMemo(parseTranscript) 被无效化。
  usePolling(
    async (isActive) => {
      if (doneRef.current) return;
      try {
        const cached = jsonlCache.get(id);
        const r = await fetch(`/api/conversations/${id}/session`, {
          cache: "no-store",
          headers: cached?.etag ? { "If-None-Match": cached.etag } : {}
        });
        if (!isActive()) return;
        if (r.status === 304) return;
        if (!r.ok) return;
        const etag = r.headers.get("ETag");
        const d = (await r.json()) as { jsonl: string | null };
        if (!isActive()) return;
        // 字符串相等：保留旧引用，setJsonl 不调用 → useMemo(parseTranscript) 命中、TranscriptView 跳过 reconcile。
        if (cached && cached.jsonl === d.jsonl) {
          jsonlCache.set(id, { jsonl: cached.jsonl, etag });
          setLoaded(true);
          return;
        }
        jsonlCache.set(id, { jsonl: d.jsonl, etag });
        setJsonl(d.jsonl);
        setLoaded(true);
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [id],
    3000
  );

  // 乐观消息清理：jsonl 或 DB 任一收录本轮即可清掉（避免重复显示）。
  // 文本消息按正文匹配 jsonl；DB 已收到等正文的 user 消息即视为「服务端已知」、可由 db 渲染接管。
  // 仅附件消息无正文，按 worker 注入 prompt 的附件路径片段（sha256 前 8 位）匹配 jsonl。
  useEffect(() => {
    setPending((p) =>
      p.filter((m) => {
        const textInJsonl = m.text.length > 0 && Boolean(jsonl?.includes(m.text));
        const textInDb =
          m.text.length > 0 &&
          dbMessages.some((dm) => dm.role === "user" && dm.body === m.text && dm.status !== "scheduled");
        const attSeen = m.attachments.some((a) => Boolean(jsonl?.includes(a.sha256.slice(0, 8))));
        return !(textInJsonl || textInDb || attSeen);
      })
    );
  }, [jsonl, dbMessages]);

  // 点菜单外区域关闭下拉。
  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);


  const items = useMemo(() => (jsonl ? parseTranscript(jsonl) : []), [jsonl]);

  // DB 兜底：把 user 消息 / 失败 assistant 消息按 seq 升序拼一份，逐条决定是否补显示——
  // jsonl 已收录正文（user）或 TranscriptView 不会代显（失败 assistant 无正文 → 永远展示错误条）。
  // 解决 jsonl 未就绪 / claude 失败 / 切页面回来 pending 已清三种「正文消失」的场景。
  const dbExtras = useMemo(() => {
    type Extra =
      | { kind: "user"; id: string; body: string }
      | { kind: "failed"; id: string; error: string };
    const out: Extra[] = [];
    const sorted = dbMessages
      .filter((m) => m.seq != null)
      .slice()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    for (const m of sorted) {
      if (m.role === "user") {
        if (m.status === "scheduled") continue;
        if (!m.body) continue;
        if (jsonl && jsonl.includes(m.body)) continue;
        out.push({ kind: "user", id: m.id, body: m.body });
      } else if (m.role === "assistant" && m.status === "failed") {
        out.push({ kind: "failed", id: m.id, error: m.error_message ?? "执行失败" });
      }
    }
    return out;
  }, [dbMessages, jsonl]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, pending, dbExtras]);

  // 回复中：有待 worker 落库的乐观消息，或列表派生的 generating（worker 正在跑本轮）。
  const busy = pending.length > 0 || conversation.generating;

  async function saveTitle(): Promise<void> {
    const t = titleDraft.trim();
    setEditingTitle(false);
    if (t === conversation.title) {
      return;
    }
    try {
      const r = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t })
      });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "改名失败");
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "改名失败");
      setTitleDraft(conversation.title);
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    const atts = draftAtts;
    if ((!text && atts.length === 0) || sending) {
      return;
    }
    // datetime-local（本地时区）→ ISO；空则立即发送。
    const scheduledAt = scheduleAt ? new Date(scheduleAt).toISOString() : undefined;
    // 立即清空输入并落乐观气泡（在网络请求之前），点完即有响应；定时消息不进气泡。
    // 失败时回滚（恢复输入、移除该乐观气泡）。修复点击后 1-2 秒才显示的卡顿。
    const optimisticKey = scheduledAt ? null : { text, attachments: atts };
    setInput("");
    setDraftAtts([]);
    if (scheduledAt) setScheduleAt("");
    if (optimisticKey) setPending((p) => [...p, optimisticKey]);
    setSending(true);
    setErr("");
    try {
      await postJson(`/api/conversations/${id}/messages`, {
        body: text,
        attachmentIds: atts.map((a) => a.id),
        ...(scheduledAt ? { scheduledAt } : {})
      });
      // 服务端落库即触发一次本对话的元信息刷新：让 dbMessages 即刻拿到这条 user 消息，
      // pending 与 dbExtras 任一渲染即可保证文本始终在视图上。
      void refreshMeta();
    } catch (e) {
      // 失败回滚：移除该乐观气泡 + 恢复输入草稿，避免「点了发送，结果什么都没留下」。
      if (optimisticKey) {
        setPending((p) => p.filter((m) => m !== optimisticKey));
      }
      setInput(text);
      setDraftAtts(atts);
      if (scheduledAt) setScheduleAt(scheduleAt);
      setErr(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  // 从草稿附件中移除一项：先 best-effort 调 DELETE 接口（已绑定的会被 unbound 校验挡住，
  // 这里只在「未提交前」用，全部 unbound），再从本地草稿移除避免界面卡住等待响应。
  async function removeDraftAttachment(attId: string): Promise<void> {
    try {
      await fetch(`/api/attachments/${attId}`, { method: "DELETE" });
    } catch {
      /* best-effort：失败时仍从草稿移除，孤儿由 cron 清 */
    }
    setDraftAtts((prev) => prev.filter((a) => a.id !== attId));
  }

  // 取消一条尚未到点的定时消息。
  async function cancelScheduled(messageId: string): Promise<void> {
    try {
      const r = await fetch(`/api/conversations/${id}/messages/${messageId}`, { method: "DELETE" });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "取消失败");
      }
      await refreshMeta();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "取消失败");
    }
  }

  // 保存会话级设置（自动回复 + 决策预案）：PATCH 后让父组件刷新列表（conversation prop 含 auto_reply 字段）。
  async function saveSettings(autoReply: boolean, autoDecisionHints: string): Promise<void> {
    const r = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReply, autoDecisionHints })
    });
    if (!r.ok) {
      throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "保存失败");
    }
    setSettingsOpen(false);
    onChanged();
  }

  async function cancelTurn(): Promise<void> {
    try {
      await postJson(`/api/conversations/${id}/cancel`, {});
      // 终止后清空乐观气泡：worker 杀进程后会把消息翻 cancelled，列表派生 generating=false；
      // 本地 pending 已无意义（不会再有应答），先清掉避免「点了终止仍显示打字中」。
      setPending([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "终止失败");
    }
  }

  async function deleteConv(): Promise<void> {
    const ok = await confirm({
      title: "删除对话",
      message: `确认删除对话「${conversation.title || "未命名对话"}」？该对话的所有消息与会话记录将一并删除，且不可恢复。`,
      confirmText: "删除对话",
      danger: true
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "删除失败");
      }
      onChanged();
      if (onBack) onBack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  }

  // worker 离线：消息接口会 400 挡掉，前端同步禁用输入框 + 顶部提示，避免「输入了 Enter 才弹错」。
  const offline = worker !== null && worker.status !== "online";

  return (
    <div className="chat-thread">
      <header className="chat-thread-head">
        {onBack ? (
          <button type="button" className="chat-back" onClick={onBack} aria-label="返回会话列表">
            <ChevronLeft size={18} />
          </button>
        ) : null}
        <div className="chat-thread-title">
          {editingTitle ? (
            <div className="chat-title-edit">
              <input
                autoFocus
                value={titleDraft}
                maxLength={200}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveTitle();
                  } else if (e.key === "Escape") {
                    setEditingTitle(false);
                    setTitleDraft(conversation.title);
                  }
                }}
                placeholder="对话标题"
              />
              <button className="icon-btn" type="button" title="保存" onClick={() => void saveTitle()}>
                <Check size={15} />
              </button>
              <button
                className="icon-btn"
                type="button"
                title="取消"
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(conversation.title);
                }}
              >
                <X size={15} />
              </button>
            </div>
          ) : (
            <strong>{conversation.title || "未命名对话"}</strong>
          )}
          <span className="chat-thread-sub">
            <Server size={12} /> {conversation.worker_name}{" "}
            {conversation.branch ? (
              <>
                <GitBranch size={12} /> {conversation.branch}{" "}
              </>
            ) : null}
            · {conversation.project_name}
            {conversation.auto_reply ? (
              <span className="chat-tag chat-tag-auto" title="已开启自动回复（无人值守）">
                <Bot size={11} /> 自动回复
              </span>
            ) : null}
          </span>
        </div>
        <div className="chat-head-menu" ref={menuRef}>
          <button
            type="button"
            className="chat-head-more"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="更多操作"
            title="更多操作"
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen ? (
            <div className="chat-head-dropdown">
              {canCommand ? (
                <button
                  type="button"
                  onClick={() => {
                    setEditingTitle(true);
                    setMenuOpen(false);
                  }}
                >
                  <Pencil size={13} /> 重命名
                </button>
              ) : null}
              {canCommand ? (
                <button
                  type="button"
                  onClick={() => {
                    setSettingsOpen(true);
                    setMenuOpen(false);
                  }}
                >
                  <Settings2 size={13} /> 对话设置
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setMetaOpen((v) => !v);
                  setMenuOpen(false);
                }}
              >
                <Info size={13} /> 会话信息
              </button>
              {canCommand ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void deleteConv();
                    setMenuOpen(false);
                  }}
                >
                  <Trash2 size={13} /> 删除对话
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <SessionMetaBar planModel={conversation.model} worker={worker} jsonl={jsonl} open={metaOpen} />

      <div className="chat-msgs" ref={scrollRef}>
        {loaded && items.length === 0 && pending.length === 0 && dbExtras.length === 0 ? (
          <Empty icon={<MessageSquare size={22} />} text="发送第一条消息开始对话" />
        ) : (
          <>
            <TranscriptView items={items} />
            {dbExtras.map((e) =>
              e.kind === "user" ? (
                <div className="tx-row user" key={`db-${e.id}`}>
                  <div className="tx-msg user">
                    <div className="tx-text">{e.body}</div>
                  </div>
                </div>
              ) : (
                <div className="tx-row asst" key={`db-${e.id}`}>
                  <div className="tx-msg asst chat-msg-failed">
                    <div className="chat-msg-failed-head">
                      <AlertTriangle size={13} aria-hidden />
                      <span>执行失败</span>
                    </div>
                    <div className="tx-text">{e.error}</div>
                  </div>
                </div>
              )
            )}
            {pending.map((m, i) => (
              <div className="tx-row user" key={`p${i}`}>
                <div className="tx-msg user">
                  {m.text ? <div className="tx-text">{m.text}</div> : null}
                  <AttachmentList attachments={m.attachments} />
                </div>
              </div>
            ))}
            {busy ? (
              <div className="tx-row asst">
                <div className="tx-thinking">
                  <span className="tx-thinking-pill" role="status" aria-label="思考中">
                    <Sparkles size={13} className="tx-thinking-ico" aria-hidden="true" />
                    <span className="tx-thinking-label">思考中…</span>
                  </span>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {err ? <div className="chat-error">{err}</div> : null}

      {/* 待发送的定时消息：在输入框上方排队展示，可逐条取消。到点由 Console 调度器提升后才进入应答流程。 */}
      {scheduled.length > 0 ? (
        <div className="chat-scheduled">
          <div className="chat-scheduled-head">
            <CalendarClock size={13} /> 定时发送（{scheduled.length}）
          </div>
          {scheduled.map((m) => (
            <div className="chat-scheduled-item" key={m.id}>
              <Clock size={12} className="chat-scheduled-ico" aria-hidden />
              <span className="chat-scheduled-time">{fmtDateTime(m.scheduled_at)}</span>
              <span className="chat-scheduled-body">{m.body || "（仅附件）"}</span>
              {canCommand ? (
                <button
                  type="button"
                  className="chat-scheduled-del"
                  title="取消定时发送"
                  aria-label="取消定时发送"
                  onClick={() => void cancelScheduled(m.id)}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {offline ? (
        <div className="chat-closed">该 worker 当前离线，无法继续对话（恢复在线后可继续）</div>
      ) : canCommand ? (
        <div className="chat-composer">
          {/* 草稿展示带：定时 chip + 已上传附件 chips。空集合时整带隐藏（CSS :empty）。 */}
          <div className="chat-composer-chips">
            {scheduleAt ? (
              <span
                className="chat-schedule-chip"
                title={`将于 ${scheduleAt.replace("T", " ")} 定时发送`}
              >
                <CalendarClock size={12} aria-hidden />
                <span>{scheduleAt.replace("T", " ")}</span>
                <button
                  type="button"
                  className="chat-schedule-chip-clear"
                  aria-label="取消定时"
                  onClick={() => setScheduleAt("")}
                  disabled={sending}
                >
                  <X size={12} />
                </button>
              </span>
            ) : null}
            {draftAtts.map((a) => (
              <AttachmentChip
                key={a.id}
                meta={a}
                onRemove={sending ? undefined : () => void removeDraftAttachment(a.id)}
              />
            ))}
          </div>
          <textarea
            className="chat-composer-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="输入消息…"
            rows={1}
          />
          <div className="chat-composer-bar">
            <span className="chat-composer-hint">
              {scheduleAt ? "将定时发送" : "Enter 发送 · Shift+Enter 换行"}
            </span>
            <div className="chat-composer-actions">
              {/* 定时按钮：紧凑圆形 trigger；direction=up 避免日历面板贴底被裁切。 */}
              <DateTimePicker
                value={scheduleAt}
                onChange={setScheduleAt}
                minNow
                direction="up"
                compact
                disabled={sending || busy}
                placeholder="定时发送…"
                ariaLabel="定时发送"
              />
              {/* 附件按钮：紧凑圆形按钮，附件 chips 在上方草稿带展示。 */}
              <AttachmentUploader
                attachments={draftAtts}
                onChange={setDraftAtts}
                disabled={sending}
                compact
                onError={setErr}
              />
              {busy ? (
                <button
                  className="chat-send chat-send-stop"
                  type="button"
                  onClick={() => void cancelTurn()}
                  title="终止本轮回答"
                  aria-label="终止本轮回答"
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="chat-send"
                  type="button"
                  disabled={sending || (!input.trim() && draftAtts.length === 0)}
                  onClick={send}
                  title={scheduleAt ? "定时发送" : "发送消息（Enter）"}
                  aria-label={scheduleAt ? "定时发送" : "发送消息"}
                >
                  {scheduleAt ? (
                    <CalendarClock size={16} strokeWidth={2.5} />
                  ) : (
                    <ArrowUp size={18} strokeWidth={2.5} />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-closed">无发送权限（需 command.create）</div>
      )}

      {settingsOpen ? (
        <ConversationSettingsModal
          conversation={conversation}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}

// 会话级设置弹窗：自动回复（无人值守）开关 + 决策预案。与任务表单的「自动回复」同设计（Select + hints）。
export function ConversationSettingsModal({
  conversation,
  onClose,
  onSave
}: {
  conversation: Conversation;
  onClose: () => void;
  onSave: (autoReply: boolean, autoDecisionHints: string) => Promise<void>;
}) {
  const [autoReply, setAutoReply] = useState(conversation.auto_reply);
  const [hints, setHints] = useState(conversation.auto_decision_hints);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(): Promise<void> {
    setBusy(true);
    setErr("");
    try {
      await onSave(autoReply, hints.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
      setBusy(false);
    }
  }

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
        <header className="chat-modal-head">
          <strong>对话设置</strong>
          <button className="icon-btn" type="button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="chat-modal-body">
          <label className="chat-field">
            <span>自动回复（兜底）</span>
            <Select
              value={autoReply ? "on" : "off"}
              onChange={(v) => setAutoReply(v === "on")}
              options={[
                { value: "off", label: "否 · 等人回复（默认）" },
                { value: "on", label: "是 · 无人值守，自主决策" }
              ]}
              ariaLabel="自动回复"
            />
          </label>
          {autoReply ? (
            <label className="chat-field">
              <span>决策预案（可选）</span>
              <textarea
                value={hints}
                onChange={(e) => setHints(e.target.value)}
                rows={3}
                placeholder="prefer minimal change; keep existing patterns; ..."
              />
            </label>
          ) : null}
          {err ? <div className="chat-error">{err}</div> : null}
        </div>
        <footer className="chat-modal-foot">
          <button className="btn btn-sm" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>
  );
}

export function NewConversationPanel({
  projects,
  workers,
  lockedProjectId,
  onClose,
  onCreated
}: {
  projects: Project[];
  workers: Worker[];
  // 锁定的项目 id：项目对话工作台进来时强制只新建该项目下的会话；不传则可自由选择。
  lockedProjectId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(lockedProjectId ?? projects[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [workerId, setWorkerId] = useState("");
  const [model, setModel] = useState("default");
  const [title, setTitle] = useState("");
  // 可选首条消息 + 定时发送时间（datetime-local 格式，空 = 立即发送）。
  const [firstMessage, setFirstMessage] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  // 会话级自动回复（无人值守）+ 决策预案，与任务表单同设计。
  const [autoReply, setAutoReply] = useState(false);
  const [autoHints, setAutoHints] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onlineWorkers = workers.filter((w) => w.status === "online");
  // 非 git 项目（vcs='none'）无分支概念：隐藏分支字段、不拉远程分支、创建时不要求 branch。
  const isGit = (projects.find((p) => p.id === projectId)?.vcs ?? "git") === "git";

  useEffect(() => {
    if (!projectId || !isGit) {
      setBranches([]);
      setBranchState("idle");
      setBranch("");
      return;
    }
    setBranchState("loading");
    fetch(`/api/projects/${projectId}/branches`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error("分支加载失败");
        }
        const d = (await r.json()) as { branches: string[] };
        setBranches(d.branches);
        const def = projects.find((p) => p.id === projectId)?.default_branch ?? "";
        setBranch((cur) => (d.branches.includes(cur) ? cur : d.branches.includes(def) ? def : (d.branches[0] ?? "")));
        setBranchState("idle");
      })
      .catch(() => {
        setBranches([]);
        setBranchState("error");
        // 拉取失败时回退到项目默认分支作为初值，用户仍可在输入框里手动改成别的分支。
        setBranch(projects.find((p) => p.id === projectId)?.default_branch ?? "");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function create(): Promise<void> {
    if (!projectId || !workerId) {
      setErr("请选择项目和 worker");
      return;
    }
    if (isGit && !branch) {
      setErr("请选择分支");
      return;
    }
    const msg = firstMessage.trim();
    if (scheduleAt && !msg) {
      setErr("设了定时发送时间，请填写首条消息内容");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          branch: isGit ? branch : "",
          workerId,
          model,
          title,
          autoReply,
          autoDecisionHints: autoHints,
          ...(msg ? { firstMessage: msg } : {}),
          ...(msg && scheduleAt ? { scheduledAt: new Date(scheduleAt).toISOString() } : {})
        })
      });
      const d = (await r.json()) as { conversation?: { id: string }; error?: string };
      if (!r.ok || !d.conversation) {
        throw new Error(d.error ?? "创建失败");
      }
      onCreated(d.conversation.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-modal-backdrop" onClick={onClose}>
      <div className="chat-modal chat-modal-wide" onClick={(e) => e.stopPropagation()}>
        <header className="chat-modal-head">
          <strong>新建对话</strong>
          <button className="icon-btn" type="button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="chat-modal-body">
          <label className="chat-field">
            <span>标题（可选）</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="不填则留空" />
          </label>
          <label className="chat-field chat-field-half">
            <span>项目</span>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={Boolean(lockedProjectId)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {isGit ? (
            <label className="chat-field chat-field-half">
              <span>
                分支
                {branchState === "loading"
                  ? "（加载中…）"
                  : branchState === "error"
                    ? "（加载失败，可手动输入）"
                    : ""}
              </span>
              {/* 用 input + datalist 而非 select：分支列表拉取失败时仍可手动输入分支名，
                  成功时 datalist 给出远程分支下拉建议。与发布任务表单的分支输入一致。 */}
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                list="cc-conv-branch-list"
                placeholder="输入或选择分支"
              />
              <datalist id="cc-conv-branch-list">
                {branches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
          ) : (
            <div className="chat-field chat-field-half">
              <span className="field-hint">非 Git 项目：无分支，Worker 在关联目录里就地对话。</span>
            </div>
          )}
          <label className="chat-field chat-field-half">
            <span>Worker（在线）</span>
            <select value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
              <option value="">选择 worker</option>
              {onlineWorkers.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label className="chat-field chat-field-half">
            <span>模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="default">默认</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </label>
          <label className="chat-field">
            <span>自动回复（兜底）</span>
            <Select
              value={autoReply ? "on" : "off"}
              onChange={(v) => setAutoReply(v === "on")}
              options={[
                { value: "off", label: "否 · 等人回复（默认）" },
                { value: "on", label: "是 · 无人值守，自主决策" }
              ]}
              ariaLabel="自动回复"
            />
          </label>
          {autoReply ? (
            <label className="chat-field">
              <span>决策预案（可选）</span>
              <textarea
                value={autoHints}
                onChange={(e) => setAutoHints(e.target.value)}
                rows={2}
                placeholder="prefer minimal change; keep existing patterns; ..."
              />
            </label>
          ) : null}
          <label className="chat-field">
            <span>首条消息（可选）</span>
            <textarea
              value={firstMessage}
              onChange={(e) => setFirstMessage(e.target.value)}
              rows={2}
              placeholder="填写则建对话后即开始；可配合下方定时发送"
            />
          </label>
          <label className="chat-field">
            <span>定时发送（可选，需先填首条消息）</span>
            <DateTimePicker
              value={scheduleAt}
              onChange={setScheduleAt}
              minNow
              disabled={!firstMessage.trim()}
              placeholder="立即发送；选择时间则定时发送"
              ariaLabel="定时发送时间"
            />
          </label>
          {err ? <div className="chat-error">{err}</div> : null}
        </div>
        <footer className="chat-modal-foot">
          <button className="btn btn-sm" type="button" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-sm btn-primary" type="button" disabled={busy} onClick={create}>
            {busy ? "创建中…" : "创建并开始"}
          </button>
        </footer>
      </div>
    </div>
  );
}
