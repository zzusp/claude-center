"use client";

import type { Conversation, ConversationMessage } from "@claude-center/db";
import { Bot, GitBranch, MessageSquare, Plus, Send, Server, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Empty, postJson } from "./shared";
import type { Overview } from "./dashboard-shared";

// 实时直连对话视图：左侧会话列表 + 新建（项目/分支/worker/模型），右侧消息线（SSE 流式打字机）+ 输入框。
// 独立于任务流，独立数据通道。详见 docs/spec/worker-direct-chat.md
export function ChatView({ overview, canCommand }: { overview: Overview; canCommand: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");

  async function loadList(): Promise<void> {
    try {
      const r = await fetch("/api/conversations", { cache: "no-store" });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "加载失败");
      }
      const d = (await r.json()) as { conversations: Conversation[] };
      setConversations(d.conversations);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }
  useEffect(() => {
    void loadList();
    const t = setInterval(() => void loadList(), 5000);
    return () => clearInterval(t);
  }, []);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="chat-wrap">
      <aside className="chat-list">
        <div className="chat-list-head">
          <span>会话</span>
          {canCommand ? (
            <button className="btn btn-sm btn-primary" type="button" onClick={() => setComposing(true)}>
              <Plus size={14} /> 新建
            </button>
          ) : null}
        </div>
        <div className="chat-list-body">
          {conversations.length === 0 ? (
            <Empty icon={<MessageSquare size={20} />} text="暂无对话" />
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chat-li${c.id === activeId ? " active" : ""}`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="chat-li-title">{c.title || "未命名对话"}</span>
                <span className="chat-li-meta">
                  <Server size={11} /> {c.worker_name} <GitBranch size={11} /> {c.branch}
                </span>
                <span className="chat-li-foot">
                  <span className="mono">{c.project_name}</span>
                  <span className={`chat-tag ${c.status}`}>{c.status === "active" ? "进行中" : "已结束"}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="chat-main">
        {active ? (
          <ChatThread key={active.id} conversation={active} canCommand={canCommand} onChanged={loadList} />
        ) : (
          <Empty icon={<MessageSquare size={28} />} text="选择左侧会话，或新建一个对话" />
        )}
      </section>

      {composing ? (
        <NewConversationPanel
          overview={overview}
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            setActiveId(id);
            void loadList();
          }}
        />
      ) : null}
      {error ? <div className="chat-error chat-error-float">{error}</div> : null}
    </div>
  );
}

function ChatThread({
  conversation,
  canCommand,
  onChanged
}: {
  conversation: Conversation;
  canCommand: boolean;
  onChanged: () => void;
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const id = conversation.id;

  async function loadDetail(): Promise<void> {
    const r = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
    if (r.ok) {
      const d = (await r.json()) as { messages: ConversationMessage[] };
      setMessages(d.messages);
    }
  }

  useEffect(() => {
    setMessages([]);
    setStreaming({});
    void loadDetail();
  }, [id]);

  // SSE：token 增量逐片到达 → 累加到 streaming[messageId]；done → 清流式态并拉一次最终消息。
  useEffect(() => {
    const es = new EventSource(`/api/conversations/${id}/stream`);
    es.addEventListener("delta", (e) => {
      const { messageId, delta } = JSON.parse((e as MessageEvent).data) as { messageId: string; delta: string };
      setStreaming((p) => ({ ...p, [messageId]: (p[messageId] ?? "") + delta }));
    });
    es.addEventListener("done", (e) => {
      const { messageId } = JSON.parse((e as MessageEvent).data) as { messageId: string };
      setStreaming((p) => {
        const n = { ...p };
        delete n[messageId];
        return n;
      });
      void loadDetail();
      onChanged();
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  const committedIds = new Set(messages.map((m) => m.id));
  const liveIds = Object.keys(streaming).filter((mid) => !committedIds.has(mid));

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
      await loadDetail();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
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

  const closed = conversation.status !== "active";

  return (
    <div className="chat-thread">
      <header className="chat-thread-head">
        <div className="chat-thread-title">
          <strong>{conversation.title || "未命名对话"}</strong>
          <span className="chat-thread-sub">
            <Server size={12} /> {conversation.worker_name} <GitBranch size={12} /> {conversation.branch} ·{" "}
            {conversation.project_name}
          </span>
        </div>
        {canCommand && !closed ? (
          <button className="btn btn-sm" type="button" onClick={closeConv}>
            结束对话
          </button>
        ) : null}
      </header>

      <div className="chat-msgs" ref={scrollRef}>
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} body={m.body} status={m.status} error={m.error_message} />
        ))}
        {liveIds.map((mid) => (
          <Bubble key={mid} role="assistant" body={streaming[mid] ?? ""} status="streaming" error={null} />
        ))}
      </div>

      {err ? <div className="chat-error">{err}</div> : null}

      {closed ? (
        <div className="chat-closed">对话已结束</div>
      ) : canCommand ? (
        <div className="chat-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            rows={2}
          />
          <button className="btn-send" type="button" disabled={sending || !input.trim()} onClick={send}>
            <Send size={16} />
          </button>
        </div>
      ) : (
        <div className="chat-closed">无发送权限（需 command.create）</div>
      )}
    </div>
  );
}

function Bubble({ role, body, status, error }: { role: string; body: string; status: string; error: string | null }) {
  const isUser = role === "user";
  return (
    <div className={`bubble-row ${isUser ? "user" : "asst"}`}>
      {!isUser ? (
        <span className="bubble-ico">
          <Bot size={15} />
        </span>
      ) : null}
      <div className={`bubble ${isUser ? "user" : "asst"}${status === "failed" ? " failed" : ""}`}>
        {status === "failed" ? <span className="bubble-err">执行失败：{error}</span> : null}
        <span className="bubble-body">{body || (status === "streaming" ? "…" : "")}</span>
        {status === "streaming" ? <span className="bubble-caret" /> : null}
      </div>
    </div>
  );
}

function NewConversationPanel({
  overview,
  onClose,
  onCreated
}: {
  overview: Overview;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState(overview.projects[0]?.id ?? "");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [workerId, setWorkerId] = useState("");
  const [model, setModel] = useState("default");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onlineWorkers = overview.workers.filter((w) => w.status === "online");

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
        const def = overview.projects.find((p) => p.id === projectId)?.default_branch ?? "";
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
              {overview.projects.map((p) => (
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
