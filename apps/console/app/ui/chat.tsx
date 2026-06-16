"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { GitBranch, MessageSquare, Plus, Search, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Empty } from "./shared";
import { useConfirm } from "./controls";
import { ChatThread, NewConversationPanel } from "./chat-thread";

// 实时直连对话视图：左侧会话列表 + 新建（项目/分支/worker/模型），右侧消息线（SSE 流式打字机）+ 输入框。
// 独立于任务流，独立数据通道。详见 docs/spec/worker-direct-chat.md
export function ChatView({
  projects,
  workers,
  canCommand,
  onRequestRefresh
}: {
  projects: Project[];
  workers: Worker[];
  canCommand: boolean;
  onRequestRefresh: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  // 筛选：keyword 走 ILIKE(title/项目名/worker 名/branch)；projectId/workerId 精确过滤。空串 = 不筛。
  const [keyword, setKeyword] = useState("");
  const [filterProjectId, setFilterProjectId] = useState("");
  const [filterWorkerId, setFilterWorkerId] = useState("");
  const { confirm, dialog } = useConfirm();

  // 筛选条件聚成 query string；空字段省略，避免每次 ?keyword= 的脏 URL 触发 next 路由缓存击穿。
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    const k = keyword.trim();
    if (k) params.set("keyword", k);
    if (filterProjectId) params.set("projectId", filterProjectId);
    if (filterWorkerId) params.set("workerId", filterWorkerId);
    const s = params.toString();
    return s ? `?${s}` : "";
  }, [keyword, filterProjectId, filterWorkerId]);

  async function loadList(query: string): Promise<void> {
    try {
      const r = await fetch(`/api/conversations${query}`, { cache: "no-store" });
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
  // 关键词输入做 300ms 防抖；项目/worker 切换立即生效。
  useEffect(() => {
    const handle = setTimeout(() => void loadList(filterQuery), 300);
    return () => clearTimeout(handle);
  }, [filterQuery]);
  useEffect(() => {
    const t = setInterval(() => void loadList(filterQuery), 5000);
    return () => clearInterval(t);
    // 轮询沿用当前 filterQuery 快照；依赖变化时 setInterval 会重建，不会用陈旧条件。
  }, [filterQuery]);
  const filtersActive = Boolean(keyword.trim() || filterProjectId || filterWorkerId);
  function clearFilters(): void {
    setKeyword("");
    setFilterProjectId("");
    setFilterWorkerId("");
  }

  async function delConv(c: Conversation): Promise<void> {
    const ok = await confirm({
      title: "删除对话",
      message: `确认删除对话「${c.title || "未命名对话"}」？该对话的所有消息与会话记录将一并删除，且不可恢复。`,
      confirmText: "删除对话",
      danger: true
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "删除失败");
      }
      if (activeId === c.id) {
        setActiveId(null);
      }
      await loadList(filterQuery);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="chat-wrap">
      <aside className="chat-list">
        <div className="chat-list-head">
          <span>会话</span>
          {canCommand ? (
            <button
              className="btn btn-sm btn-primary"
              type="button"
              onClick={() => {
                onRequestRefresh();
                setComposing(true);
              }}
            >
              <Plus size={14} /> 新建
            </button>
          ) : null}
        </div>
        <div className="chat-filter">
          <div className="chat-filter-search">
            <Search size={13} />
            <input
              type="search"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索标题 / 项目 / Worker / 分支"
              aria-label="关键词搜索"
            />
          </div>
          <select
            value={filterProjectId}
            onChange={(e) => setFilterProjectId(e.target.value)}
            aria-label="按项目筛选"
            title="按项目筛选"
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={filterWorkerId}
            onChange={(e) => setFilterWorkerId(e.target.value)}
            aria-label="按 worker 筛选"
            title="按 worker 筛选"
          >
            <option value="">全部 Worker</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {filtersActive ? (
            <button type="button" className="icon-btn" title="清空筛选" onClick={clearFilters}>
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="chat-list-body">
          {conversations.length === 0 ? (
            <Empty icon={<MessageSquare size={20} />} text={filtersActive ? "无匹配的会话" : "暂无对话"} />
          ) : (
            conversations.map((c) => (
              <div key={c.id} className={`chat-li${c.id === activeId ? " active" : ""}`}>
                <button type="button" className="chat-li-main" onClick={() => setActiveId(c.id)}>
                  <span className="chat-li-title">{c.title || "未命名对话"}</span>
                  <span className="chat-li-meta">
                    <Server size={11} /> {c.worker_name} <GitBranch size={11} /> {c.branch}
                  </span>
                  <span className="chat-li-foot">
                    <span className="mono">{c.project_name}</span>
                    <span className="chat-li-tags">
                      {c.generating ? <span className="chat-tag live">回复中</span> : null}
                      <span className={`chat-tag ${c.status}`}>{c.status === "active" ? "进行中" : "已结束"}</span>
                    </span>
                  </span>
                </button>
                {canCommand ? (
                  <button
                    type="button"
                    className="chat-li-del"
                    title="删除对话"
                    onClick={() => void delConv(c)}
                  >
                    <Trash2 size={13} />
                  </button>
                ) : null}
              </div>
            ))
          )}
        </div>
      </aside>

      <section className="chat-main">
        {active ? (
          <ChatThread
            key={active.id}
            conversation={active}
            canCommand={canCommand}
            onChanged={() => void loadList(filterQuery)}
          />
        ) : (
          <Empty icon={<MessageSquare size={28} />} text="选择左侧会话，或新建一个对话" />
        )}
      </section>

      {composing ? (
        <NewConversationPanel
          projects={projects}
          workers={workers}
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            setActiveId(id);
            void loadList(filterQuery);
          }}
        />
      ) : null}
      {error ? <div className="chat-error chat-error-float">{error}</div> : null}
      {dialog}
    </div>
  );
}
