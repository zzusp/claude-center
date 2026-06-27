"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty } from "./shared";
import { useConfirm } from "./controls";
import { ChatSidebar, type ConvAction } from "./chat-sidebar";
import { ChatThread, ConversationSettingsModal, NewConversationPanel } from "./chat-thread";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";

// 实时对话总视图：左侧项目树（点项目展开内嵌会话历史）+ 右侧消息线（未选 → 空态）。
// 与旧版「项目网格首页 + 单项目工作台」相比，这一版按 Claude 网页版风格把项目导航与会话历史合并到同一栏。
export function ChatView({
  initialProjectId,
  initialConversationId,
  projects,
  workers,
  loaded,
  canCommand,
  onRequestRefresh,
  onProjectChange,
  onConversationChange
}: {
  initialProjectId: string | null;
  initialConversationId: string | null;
  projects: Project[];
  workers: Worker[];
  loaded: boolean;
  canCommand: boolean;
  onRequestRefresh: () => void;
  // 项目/会话选中变化：上层用 router 同步到 URL，便于刷新 / 分享 / 后退键还原状态。
  onProjectChange: (projectId: string | null) => void;
  onConversationChange: (projectId: string, conversationId: string | null) => void;
}) {
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(initialProjectId);
  const [activeConvId, setActiveConvId] = useState<string | null>(initialConversationId);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoaded, setConvsLoaded] = useState(false);
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [settingsTarget, setSettingsTarget] = useState<Conversation | null>(null);
  const { confirm, dialog } = useConfirm();

  // URL → 内部态同步：返回键 / 直接刷新等场景下，page 上层会重新挂载并传入新的 initial*。
  useEffect(() => {
    setExpandedProjectId(initialProjectId);
  }, [initialProjectId]);
  useEffect(() => {
    setActiveConvId(initialConversationId);
  }, [initialConversationId]);

  // 项目载入完成且初始 projectId 不在可见列表里（无权 / 已删）：退回首页。
  useEffect(() => {
    if (!loaded) return;
    if (initialProjectId && !projects.some((p) => p.id === initialProjectId)) {
      onProjectChange(null);
    }
  }, [loaded, projects, initialProjectId, onProjectChange]);

  // 切换展开项目时复位会话态，避免上一项目的对话残影。
  useEffect(() => {
    setConversations([]);
    setConvsLoaded(false);
    setRenamingId(null);
  }, [expandedProjectId]);

  const filterQuery = useMemo(() => {
    if (!expandedProjectId) return "";
    return `?projectId=${encodeURIComponent(expandedProjectId)}`;
  }, [expandedProjectId]);

  const loadList = useCallback(
    async (query: string, isActive: () => boolean = () => true): Promise<void> => {
      if (!query) {
        setConversations([]);
        setConvsLoaded(true);
        return;
      }
      try {
        const r = await fetch(`/api/conversations${query}`, { cache: "no-store" });
        if (!r.ok) {
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "加载失败");
        }
        const d = (await r.json()) as { conversations: Conversation[] };
        if (!isActive()) return;
        setConversations(d.conversations);
        setConvsLoaded(true);
        setError("");
      } catch (e) {
        if (!isActive()) return;
        setError(e instanceof Error ? e.message : "加载失败");
        setConvsLoaded(true);
      }
    },
    []
  );

  // filterQuery 变化（含项目切换）即重拉；展开后按 POLL 间隔同步对话列表。
  usePolling((isActive) => loadList(filterQuery, isActive), [filterQuery], POLL_INTERVAL_MS);

  // 项目展开切换：同项目→收起；异项目→替换。
  function toggleProject(id: string): void {
    if (expandedProjectId === id) {
      setExpandedProjectId(null);
      setActiveConvId(null);
      onProjectChange(null);
    } else {
      setExpandedProjectId(id);
      setActiveConvId(null);
      onProjectChange(id);
    }
  }

  function selectConversation(convId: string): void {
    if (!expandedProjectId) return;
    setActiveConvId(convId);
    onConversationChange(expandedProjectId, convId);
  }

  function openNewConversation(projectId: string): void {
    onRequestRefresh();
    setComposeProjectId(projectId);
    setComposing(true);
  }

  function handleConvAction(action: ConvAction, c: Conversation): void {
    if (action === "rename") {
      setRenamingId(c.id);
      setRenameDraft(c.title);
    } else if (action === "settings") {
      setSettingsTarget(c);
    } else if (action === "delete") {
      void delConv(c);
    }
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
      if (activeConvId === c.id) {
        setActiveConvId(null);
        if (expandedProjectId) onConversationChange(expandedProjectId, null);
      }
      await loadList(filterQuery);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
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

  const active = conversations.find((c) => c.id === activeConvId) ?? null;

  if (!loaded) {
    return <div className="chat-projects-loading">加载项目…</div>;
  }

  return (
    // data-active 驱动移动端主从切换：未选会话(0)显示侧栏、选中(1)显示消息线（桌面端双栏并排）。
    <div className="chat-wrap" data-active={active ? "1" : "0"}>
      <ChatSidebar
        projects={projects}
        expandedProjectId={expandedProjectId}
        conversations={conversations}
        conversationsLoaded={convsLoaded}
        activeConvId={activeConvId}
        canCommand={canCommand}
        renamingConvId={renamingId}
        renameDraft={renameDraft}
        onRenameDraft={setRenameDraft}
        onToggleProject={toggleProject}
        onSelectConversation={selectConversation}
        onNewConversation={openNewConversation}
        onConvAction={handleConvAction}
        onCommitRename={commitRename}
        onCancelRename={() => setRenamingId(null)}
      />

      <section className="chat-main">
        {active ? (
          <ChatThread
            key={active.id}
            conversation={active}
            canCommand={canCommand}
            onChanged={() => void loadList(filterQuery)}
            onBack={() => {
              setActiveConvId(null);
              if (expandedProjectId) onConversationChange(expandedProjectId, null);
            }}
          />
        ) : (
          <Empty
            icon={<MessageSquare size={28} />}
            text={expandedProjectId ? "选择左侧会话，或新建一个对话" : "选择左侧项目展开会话历史"}
          />
        )}
      </section>

      {composing && composeProjectId ? (
        <NewConversationPanel
          projects={projects}
          workers={workers}
          lockedProjectId={composeProjectId}
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            setActiveConvId(id);
            if (composeProjectId) {
              setExpandedProjectId(composeProjectId);
              onConversationChange(composeProjectId, id);
            }
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
