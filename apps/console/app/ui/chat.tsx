"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Empty } from "./shared";
import { useConfirm } from "./controls";
import { ChatSidebar, type ConvAction } from "./chat-sidebar";
import { ChatThread, ConversationSettingsModal, NewConversationPanel } from "./chat-thread";

// 实时对话总视图：左侧项目树（点项目展开内嵌会话历史）+ 右侧消息线（未选 → 空态）。
// 与旧版「项目网格首页 + 单项目工作台」相比，这一版按 Claude 网页版风格把项目导航与会话历史合并到同一栏。
export function ChatView({
  initialProjectId,
  initialConversationId,
  projects,
  conversationsByProject,
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
  // 进页面时由 /api/projects?include=conversations 一次拿齐的「每个项目下的对话」预载缓存。
  // 项目展开即从这里读取直接显示，避免再发 /api/conversations?projectId=X 触发「加载中…」。
  conversationsByProject: Record<string, Conversation[]>;
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
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeProjectId, setComposeProjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [settingsTarget, setSettingsTarget] = useState<Conversation | null>(null);
  const { confirm, dialog } = useConfirm();

  // 项目载入完成且初始 projectId 不在可见列表里（无权 / 已删）：退回首页。
  useEffect(() => {
    if (!loaded) return;
    if (initialProjectId && !projects.some((p) => p.id === initialProjectId)) {
      onProjectChange(null);
      setExpandedProjectId(null);
    }
  }, [loaded, projects, initialProjectId, onProjectChange]);

  // 切换展开项目时复位行内改名草稿；对话列表由 conversationsByProject 直接派生，无需本地缓存。
  useEffect(() => {
    setRenamingId(null);
  }, [expandedProjectId]);

  // 当前展开项目对应的对话列表：父组件一次性拿齐 conversationsByProject 后，展开时直接派生，
  // 不再发 /api/conversations?projectId=X，也不在切项目时触发任何网络请求。
  const conversations = useMemo<Conversation[]>(
    () => (expandedProjectId ? conversationsByProject[expandedProjectId] ?? [] : []),
    [expandedProjectId, conversationsByProject]
  );

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
      onRequestRefresh();
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
      onRequestRefresh();
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
    onRequestRefresh();
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
        conversationsLoaded={loaded}
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
            onChanged={onRequestRefresh}
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
            onRequestRefresh();
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
