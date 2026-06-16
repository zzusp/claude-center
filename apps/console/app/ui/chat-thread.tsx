"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { Check, GitBranch, MessageSquare, Pencil, Send, Server, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Empty, postJson } from "./shared";
import { SessionMetaBar } from "./session-meta";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";

// 对话消息线（右侧）+ 新建对话面板（模态）。从 chat.tsx 抽出；ChatView 仍管会话列表与编排。
export function ChatThread({
  conversation,
  canCommand,
  onChanged
}: {
  conversation: Conversation;
  canCommand: boolean;
  onChanged: () => void;
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const id = conversation.id;
  const closed = conversation.status !== "active";

  // 会话切换 / 标题被外部刷新时，重置改名草稿与编辑态。
  useEffect(() => {
    setTitleDraft(conversation.title);
    setEditingTitle(false);
  }, [conversation.title, id]);

  // 切换会话：重置回放态 + 清空 worker 元信息（下个 polling 周期重新填充）。
  useEffect(() => {
    setJsonl(null);
    setLoaded(false);
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
  usePolling(
    async (isActive) => {
      if (doneRef.current) return;
      try {
        const r = await fetch(`/api/conversations/${id}/session`, { cache: "no-store" });
        if (!r.ok) return;
        const d = (await r.json()) as { jsonl: string | null };
        if (!isActive()) return;
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

  async function closeConv(): Promise<void> {
    try {
      await postJson(`/api/conversations/${id}/close`, {});
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "结束失败");
    }
  }

  return (
    <div className="chat-thread">
      <header className="chat-thread-head">
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
            <div className="chat-title-show">
              <strong>{conversation.title || "未命名对话"}</strong>
              {canCommand ? (
                <button className="icon-btn chat-title-pen" type="button" title="重命名" onClick={() => setEditingTitle(true)}>
                  <Pencil size={13} />
                </button>
              ) : null}
            </div>
          )}
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

      <SessionMetaBar planModel={conversation.model} worker={worker} jsonl={jsonl} />

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
                <div className="tx-msg asst">
                  <span className="bubble-dots" aria-label="回复中">
                    <i />
                    <i />
                    <i />
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
