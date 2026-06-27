"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import {
  ArrowLeft,
  Check,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "./shared";
import { Select, useConfirm } from "./controls";
import { ChatThread, ConversationSettingsModal, NewConversationPanel } from "./chat-thread";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";

// 项目对话工作台：限定到单个项目（project!=null 时按 projectId 过滤；项目尚未载入完成时整体置 loading）。
// 左侧会话列表（仅标题 + 三点菜单：重命名 / 设置 / 删除）；右侧消息线。
export function ChatView({
  project,
  projects,
  workers,
  canCommand,
  onRequestRefresh,
  onBackToProjects
}: {
  project: Project | null;
  projects: Project[];
  workers: Worker[];
  canCommand: boolean;
  onRequestRefresh: () => void;
  onBackToProjects: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [filterWorkerId, setFilterWorkerId] = useState("");
  const { confirm, dialog } = useConfirm();

  // 列表项三点菜单：同一时刻只展开一个；用 conversationId 作 key，null=全部关闭。
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // 行内重命名：编辑中的 id + 当前草稿。
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // 设置弹窗（自动回复 + 决策预案）：直接复用 chat-thread 里的 ConversationSettingsModal。
  const [settingsTarget, setSettingsTarget] = useState<Conversation | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 切换项目时清空选中态，避免上一项目的会话还显示在右侧。
  useEffect(() => {
    setActiveId(null);
    setKeyword("");
    setFilterWorkerId("");
    setOpenMenuId(null);
    setRenamingId(null);
  }, [project?.id]);

  // deep-link：?c=<id> 跳进来时定位到该会话（兼容 worker 详情等链接）。
  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get("c");
    if (cid) setActiveId(cid);
  }, []);

  // 关键词输入做 300ms 防抖。
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedKeyword(keyword.trim()), 300);
    return () => clearTimeout(handle);
  }, [keyword]);

  // 筛选条件聚成 query string；projectId 强制锁定为当前项目。
  const filterQuery = useMemo(() => {
    if (!project) return "";
    const params = new URLSearchParams();
    params.set("projectId", project.id);
    if (debouncedKeyword) params.set("keyword", debouncedKeyword);
    if (filterWorkerId) params.set("workerId", filterWorkerId);
    return `?${params.toString()}`;
  }, [project, debouncedKeyword, filterWorkerId]);

  const loadList = useCallback(
    async (query: string, isActive: () => boolean = () => true): Promise<void> => {
      if (!query) return;
      try {
        const r = await fetch(`/api/conversations${query}`, { cache: "no-store" });
        if (!r.ok) {
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "加载失败");
        }
        const d = (await r.json()) as { conversations: Conversation[] };
        if (!isActive()) return;
        setConversations(d.conversations);
        setActiveId((prev) => (prev && d.conversations.some((c) => c.id === prev) ? prev : null));
        setError("");
      } catch (e) {
        if (!isActive()) return;
        setError(e instanceof Error ? e.message : "加载失败");
      }
    },
    []
  );

  // 会话列表实时同步：filterQuery 变化（含防抖关键词、worker 切换、项目切换）即重拉。
  usePolling((isActive) => loadList(filterQuery, isActive), [filterQuery], POLL_INTERVAL_MS);

  // 点菜单外部关闭下拉。
  useEffect(() => {
    if (!openMenuId) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openMenuId]);

  const workerOptions = useMemo(() => {
    if (!project) return workers;
    // 当前项目相关的 worker 子集：尽量按 worker 关联项目过滤；当前 worker 接口不返回 link，先全量。
    return workers;
  }, [workers, project]);

  const filtersActive = Boolean(keyword.trim() || filterWorkerId);
  function clearFilters(): void {
    setKeyword("");
    setFilterWorkerId("");
  }

  async function delConv(c: Conversation): Promise<void> {
    setOpenMenuId(null);
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

  function startRename(c: Conversation): void {
    setOpenMenuId(null);
    setRenamingId(c.id);
    setRenameDraft(c.title);
  }

  async function commitRename(c: Conversation): Promise<void> {
    const t = renameDraft.trim();
    setRenamingId(null);
    if (t === c.title) return;
    try {
      const r = await fetch(`/api/conversations/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t })
      });
      if (!r.ok) {
        throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "改名失败");
      }
      await loadList(filterQuery);
    } catch (e) {
      setError(e instanceof Error ? e.message : "改名失败");
    }
  }

  async function saveSettings(autoReply: boolean, autoDecisionHints: string): Promise<void> {
    if (!settingsTarget) return;
    const r = await fetch(`/api/conversations/${settingsTarget.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoReply, autoDecisionHints })
    });
    if (!r.ok) {
      throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "保存失败");
    }
    setSettingsTarget(null);
    await loadList(filterQuery);
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;

  if (!project) {
    return <div className="chat-projects-loading">加载项目…</div>;
  }

  return (
    // data-active 驱动移动端主从切换：未选会话(0)显示列表、选中(1)显示消息线（桌面端双栏并排）。
    <div className="chat-wrap" data-active={active ? "1" : "0"}>
      <aside className="chat-list">
        <div className="chat-list-head">
          <button
            type="button"
            className="chat-back-projects"
            onClick={onBackToProjects}
            title="返回项目列表"
            aria-label="返回项目列表"
          >
            <ArrowLeft size={14} />
          </button>
          <span className="chat-list-head-title" title={project.name}>
            {project.name}
          </span>
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
              placeholder="搜索标题 / Worker / 分支"
              aria-label="关键词搜索"
            />
          </div>
          <Select
            className="chat-filter-select"
            value={filterWorkerId}
            onChange={setFilterWorkerId}
            options={[
              { value: "", label: "全部 Worker" },
              ...workerOptions.map((w) => ({ value: w.id, label: w.name }))
            ]}
            ariaLabel="按 worker 筛选"
          />
          {filtersActive ? (
            <button type="button" className="icon-btn" title="清空筛选" onClick={clearFilters}>
              <X size={13} />
            </button>
          ) : null}
        </div>
        <div className="chat-list-body" ref={menuRef}>
          {conversations.length === 0 ? (
            <Empty icon={<MessageSquare size={20} />} text={filtersActive ? "无匹配的会话" : "暂无对话"} />
          ) : (
            conversations.map((c) => {
              const isActive = c.id === activeId;
              const isRenaming = renamingId === c.id;
              const isMenuOpen = openMenuId === c.id;
              return (
                <div key={c.id} className={`chat-li chat-li-simple${isActive ? " active" : ""}`}>
                  {isRenaming ? (
                    <div className="chat-li-rename">
                      <input
                        autoFocus
                        value={renameDraft}
                        maxLength={200}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitRename(c);
                          } else if (e.key === "Escape") {
                            setRenamingId(null);
                          }
                        }}
                        onBlur={() => void commitRename(c)}
                        placeholder="对话标题"
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        title="保存"
                        onClick={() => void commitRename(c)}
                      >
                        <Check size={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="chat-li-main chat-li-main-simple"
                      onClick={() => setActiveId(c.id)}
                      title={c.title || "未命名对话"}
                    >
                      <span className="chat-li-title">{c.title || "未命名对话"}</span>
                      {c.generating ? <span className="chat-tag live">回复中</span> : null}
                    </button>
                  )}
                  {canCommand && !isRenaming ? (
                    <div className="chat-li-menu">
                      <button
                        type="button"
                        className="chat-li-more"
                        title="更多操作"
                        aria-label="更多操作"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(isMenuOpen ? null : c.id);
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {isMenuOpen ? (
                        <div className="chat-li-dropdown">
                          <button type="button" onClick={() => startRename(c)}>
                            <Pencil size={13} /> 重命名
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setSettingsTarget(c);
                              setOpenMenuId(null);
                            }}
                          >
                            <Settings2 size={13} /> 对话设置
                          </button>
                          <button type="button" className="danger" onClick={() => void delConv(c)}>
                            <Trash2 size={13} /> 删除对话
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })
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
            onBack={() => setActiveId(null)}
          />
        ) : (
          <Empty icon={<MessageSquare size={28} />} text="选择左侧会话，或新建一个对话" />
        )}
      </section>

      {composing ? (
        <NewConversationPanel
          projects={projects}
          workers={workers}
          lockedProjectId={project.id}
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            setActiveId(id);
            void loadList(filterQuery);
          }}
        />
      ) : null}
      {settingsTarget ? (
        <ConversationSettingsModal
          conversation={settingsTarget}
          onClose={() => setSettingsTarget(null)}
          onSave={saveSettings}
        />
      ) : null}
      {error ? <div className="chat-error chat-error-float">{error}</div> : null}
      {dialog}
    </div>
  );
}

