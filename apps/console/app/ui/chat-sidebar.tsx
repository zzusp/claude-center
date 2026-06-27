"use client";

import type { Conversation, Project } from "@claude-center/db";
import {
  Check,
  ChevronDown,
  FolderGit2,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Settings2,
  SquarePen,
  Trash2
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

// 折叠态展示的会话数量上限；超出由「展开显示」一次性放开。
const COLLAPSED_LIMIT = 5;

// 极简相对时间：参考图里的「2 周 / 3 天 / 刚刚」。仅 sidebar 列表项用，不抽到 shared.tsx 以免被任务流误用。
function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  const day = Math.floor(h / 24);
  if (day < 7) return `${day} 天`;
  const w = Math.floor(day / 7);
  if (w < 5) return `${w} 周`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} 个月`;
  return `${Math.floor(day / 365)} 年`;
}

export type ConvAction = "rename" | "settings" | "delete";

// 实时对话左侧栏（Claude 网页版项目树风格）：项目展开后内嵌该项目下的会话历史。
// 仅渲染 + 透出事件；项目展开 / 会话选中 / 重命名 / 新建对话等业务态均由 ChatView 持有。
export function ChatSidebar({
  projects,
  expandedProjectId,
  conversations,
  conversationsLoaded,
  activeConvId,
  canCommand,
  renamingConvId,
  renameDraft,
  onRenameDraft,
  onToggleProject,
  onSelectConversation,
  onNewConversation,
  onConvAction,
  onCommitRename,
  onCancelRename
}: {
  projects: Project[];
  expandedProjectId: string | null;
  conversations: Conversation[];
  conversationsLoaded: boolean;
  activeConvId: string | null;
  canCommand: boolean;
  renamingConvId: string | null;
  renameDraft: string;
  onRenameDraft: (s: string) => void;
  onToggleProject: (id: string) => void;
  onSelectConversation: (id: string) => void;
  onNewConversation: (projectId: string) => void;
  onConvAction: (action: ConvAction, c: Conversation) => void;
  onCommitRename: (c: Conversation) => void;
  onCancelRename: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [openConvMenuId, setOpenConvMenuId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 切项目时复位「展开显示」与下拉菜单。
  useEffect(() => {
    setShowAll(false);
    setOpenConvMenuId(null);
  }, [expandedProjectId]);

  // 点菜单外区域关闭单条会话下拉。
  useEffect(() => {
    if (!openConvMenuId) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenConvMenuId(null);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [openConvMenuId]);

  const visible = showAll ? conversations : conversations.slice(0, COLLAPSED_LIMIT);

  return (
    <aside className="chat-side">
      <div className="chat-side-head">
        <span className="chat-side-title">项目</span>
      </div>
      <nav className="chat-side-tree">
        {projects.length === 0 ? <div className="chat-side-empty">暂无项目</div> : null}
        {projects.map((p) => {
          const expanded = p.id === expandedProjectId;
          return (
            <div key={p.id} className={`chat-side-project${expanded ? " open" : ""}`}>
              <div
                className="chat-side-project-row"
                role="button"
                tabIndex={0}
                onClick={() => onToggleProject(p.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onToggleProject(p.id);
                  }
                }}
                title={p.name}
              >
                <span className="chat-side-project-ico">
                  {p.vcs === "git" ? <FolderGit2 size={14} /> : <FolderTree size={14} />}
                </span>
                <span className="chat-side-project-name">{p.name}</span>
                <span className="chat-side-project-tail">
                  {expanded ? <ChevronDown size={14} className="chat-side-chevron" /> : null}
                  {expanded && canCommand ? (
                    <>
                      <button
                        type="button"
                        className="chat-side-act hov-only"
                        title="更多操作"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      <button
                        type="button"
                        className="chat-side-act hov-only"
                        title="新建对话"
                        aria-label="新建对话"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewConversation(p.id);
                        }}
                      >
                        <SquarePen size={14} />
                      </button>
                    </>
                  ) : null}
                </span>
              </div>
              {expanded ? (
                <div className="chat-side-conv-list" ref={menuRef}>
                  {!conversationsLoaded ? (
                    <div className="chat-side-conv-empty">加载中…</div>
                  ) : conversations.length === 0 ? (
                    <div className="chat-side-conv-empty">暂无对话</div>
                  ) : (
                    <>
                      {visible.map((c) => {
                        const active = c.id === activeConvId;
                        const renaming = renamingConvId === c.id;
                        const menuOpen = openConvMenuId === c.id;
                        return (
                          <div key={c.id} className={`chat-side-conv${active ? " active" : ""}`}>
                            {renaming ? (
                              <div className="chat-side-conv-rename">
                                <input
                                  autoFocus
                                  value={renameDraft}
                                  maxLength={200}
                                  onChange={(e) => onRenameDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      onCommitRename(c);
                                    } else if (e.key === "Escape") {
                                      onCancelRename();
                                    }
                                  }}
                                  onBlur={() => onCommitRename(c)}
                                  placeholder="对话标题"
                                />
                                <button
                                  type="button"
                                  className="chat-side-conv-confirm"
                                  title="保存"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => onCommitRename(c)}
                                >
                                  <Check size={13} />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="chat-side-conv-main"
                                onClick={() => onSelectConversation(c.id)}
                                title={c.title || "未命名对话"}
                              >
                                <span className="chat-side-conv-title">{c.title || "未命名对话"}</span>
                                <span className="chat-side-conv-time">
                                  {c.generating ? (
                                    <span className="chat-tag live" title="回复中">
                                      回复中
                                    </span>
                                  ) : (
                                    relTime(c.last_message_at ?? c.updated_at)
                                  )}
                                </span>
                              </button>
                            )}
                            {canCommand && !renaming ? (
                              <div className="chat-side-conv-menu">
                                <button
                                  type="button"
                                  className="chat-side-act"
                                  title="更多操作"
                                  aria-label="更多操作"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenConvMenuId(menuOpen ? null : c.id);
                                  }}
                                >
                                  <MoreHorizontal size={14} />
                                </button>
                                {menuOpen ? (
                                  <div className="chat-side-conv-dropdown">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenConvMenuId(null);
                                        onConvAction("rename", c);
                                      }}
                                    >
                                      <Pencil size={13} /> 重命名
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenConvMenuId(null);
                                        onConvAction("settings", c);
                                      }}
                                    >
                                      <Settings2 size={13} /> 对话设置
                                    </button>
                                    <button
                                      type="button"
                                      className="danger"
                                      onClick={() => {
                                        setOpenConvMenuId(null);
                                        onConvAction("delete", c);
                                      }}
                                    >
                                      <Trash2 size={13} /> 删除对话
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                      {!showAll && conversations.length > COLLAPSED_LIMIT ? (
                        <button
                          type="button"
                          className="chat-side-show-more"
                          onClick={() => setShowAll(true)}
                        >
                          展开显示
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
