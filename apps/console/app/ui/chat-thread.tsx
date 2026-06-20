"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { ArrowUp, Check, ChevronLeft, GitBranch, Info, MessageSquare, MoreHorizontal, Pencil, Server, Sparkles, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, postJson } from "./shared";
import { SessionMetaBar } from "./session-meta";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";

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
  const [pending, setPending] = useState<string[]>([]);
  const [input, setInput] = useState("");
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const id = conversation.id;
  const closed = conversation.status !== "active";

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
    doneRef.current = false;
  }, [id]);

  // 轮询对话详情拿 worker 快照（claude_version / subscription / usage）。
  // worker 本身不会换、变化是 5h/7d 套餐窗位移（分钟级漂移），消息流事件与 usage 无关：
  // 不订阅 relay，节奏拉到 15s，避免每条消息事件都顺手刷一遍这个无关接口。
  usePolling(
    async (isActive) => {
      try {
        const r = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { worker: Worker | null };
        if (!isActive()) return;
        setWorker(d.worker);
      } catch {
        /* 轮询失败静默 */
      }
    },
    [id],
    15_000,
    { relay: false }
  );

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
        if (r.status === 304) {
          if (closed) doneRef.current = true;
          return;
        }
        if (!r.ok) return;
        const etag = r.headers.get("ETag");
        const d = (await r.json()) as { jsonl: string | null };
        if (!isActive()) return;
        // 字符串相等：保留旧引用，setJsonl 不调用 → useMemo(parseTranscript) 命中、TranscriptView 跳过 reconcile。
        if (cached && cached.jsonl === d.jsonl) {
          jsonlCache.set(id, { jsonl: cached.jsonl, etag });
          setLoaded(true);
          if (closed) doneRef.current = true;
          return;
        }
        jsonlCache.set(id, { jsonl: d.jsonl, etag });
        setJsonl(d.jsonl);
        setLoaded(true);
        if (closed) doneRef.current = true;
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [id, closed],
    3000
  );

  // 乐观消息：发送后到 worker 把该轮写进 jsonl 之间有延迟窗，先本地显示；jsonl 收录后清掉避免重复。
  useEffect(() => {
    if (!jsonl) return;
    setPending((p) => p.filter((t) => !jsonl.includes(t)));
  }, [jsonl]);

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, pending]);

  // 回复中：有待 worker 落库的乐观消息，或列表派生的 generating（worker 正在跑本轮）。
  const busy = !closed && (pending.length > 0 || conversation.generating);

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
    if (!text || sending) {
      return;
    }
    setSending(true);
    setErr("");
    try {
      await postJson(`/api/conversations/${id}/messages`, { body: text });
      setInput("");
      setPending((p) => [...p, text]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
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

  async function closeConv(): Promise<void> {
    try {
      await postJson(`/api/conversations/${id}/close`, {});
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "结束失败");
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
            <Server size={12} /> {conversation.worker_name} <GitBranch size={12} /> {conversation.branch} ·{" "}
            {conversation.project_name}
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
              <button
                type="button"
                onClick={() => {
                  setMetaOpen((v) => !v);
                  setMenuOpen(false);
                }}
              >
                <Info size={13} /> 会话信息
              </button>
              {canCommand && !closed ? (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    void closeConv();
                    setMenuOpen(false);
                  }}
                >
                  <Square size={13} /> 结束对话
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <SessionMetaBar planModel={conversation.model} worker={worker} jsonl={jsonl} open={metaOpen} />

      <div className="chat-msgs" ref={scrollRef}>
        {loaded && items.length === 0 && pending.length === 0 ? (
          <Empty icon={<MessageSquare size={22} />} text="发送第一条消息开始对话" />
        ) : (
          <>
            <TranscriptView items={items} />
            {pending.map((t, i) => (
              <div className="tx-row user" key={`p${i}`}>
                <div className="tx-msg user">
                  <div className="tx-text">{t}</div>
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

      {closed ? (
        <div className="chat-closed">对话已结束</div>
      ) : offline ? (
        <div className="chat-closed">该 worker 当前离线，无法继续对话（恢复在线后可继续）</div>
      ) : canCommand ? (
        <div className="chat-composer">
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
            <span className="chat-composer-hint">Enter 发送 · Shift+Enter 换行</span>
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
                disabled={sending || !input.trim()}
                onClick={send}
                title="发送消息（Enter）"
                aria-label="发送消息"
              >
                <ArrowUp size={18} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="chat-closed">无发送权限（需 command.create）</div>
      )}
    </div>
  );
}

export function NewConversationPanel({
  projects,
  workers,
  onClose,
  onCreated
}: {
  projects: Project[];
  workers: Worker[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [workerId, setWorkerId] = useState("");
  const [model, setModel] = useState("default");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onlineWorkers = workers.filter((w) => w.status === "online");

  useEffect(() => {
    if (!projectId) {
      setBranches([]);
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
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function create(): Promise<void> {
    if (!projectId || !workerId || !branch) {
      setErr("请选择项目、分支和 worker");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, branch, workerId, model, title })
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
      <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
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
          <label className="chat-field">
            <span>项目</span>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="chat-field">
            <span>
              分支
              {branchState === "loading" ? "（加载中…）" : branchState === "error" ? "（加载失败）" : ""}
            </span>
            <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={branches.length === 0}>
              {branches.length === 0 ? (
                <option value="">—</option>
              ) : (
                branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="chat-field">
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
          <label className="chat-field">
            <span>模型</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="default">默认</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
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
