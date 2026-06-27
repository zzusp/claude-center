"use client";

import type { Project } from "@claude-center/db";
import { FolderGit2, FolderTree, MessageSquare } from "lucide-react";
import Link from "next/link";
import { Empty } from "./shared";

// 实时对话首页：项目网格（cowork 风格）。
// 点击项目卡进入 /chat/[projectId]，由项目工作台承载会话列表 + 对话线。
// 现阶段不做按项目维度的实时统计（待 /api/projects 扩字段后再做）；卡片只显示项目元信息与「进入对话」入口。
export function ChatProjectsView({
  projects,
  loaded,
  error,
  canCommand
}: {
  projects: Project[];
  loaded: boolean;
  error: string;
  canCommand: boolean;
}) {
  if (!loaded) {
    return <div className="chat-projects-loading">加载项目…</div>;
  }
  if (error) {
    return <div className="chat-error chat-error-float">{error}</div>;
  }
  if (projects.length === 0) {
    return (
      <Empty
        icon={<FolderGit2 size={28} />}
        text={canCommand ? "暂无项目，请先到「代码项目」新建" : "暂无可访问的项目"}
      />
    );
  }
  return (
    <div className="chat-projects">
      <div className="chat-projects-head">
        <span className="chat-projects-title">选择项目进入对话</span>
        <span className="chat-projects-sub">每个项目下管理与 Worker 的实时对话</span>
      </div>
      <div className="chat-projects-grid">
        {projects.map((p) => (
          <Link key={p.id} href={`/chat/${p.id}`} className="chat-project-card">
            <span className="chat-project-card-ico">
              {p.vcs === "git" ? <FolderGit2 size={18} /> : <FolderTree size={18} />}
            </span>
            <span className="chat-project-card-body">
              <span className="chat-project-card-name">{p.name}</span>
              {p.description ? <span className="chat-project-card-desc">{p.description}</span> : null}
              <span className="chat-project-card-meta">
                {p.vcs === "git" ? (
                  <span className="mono">{p.repo_url}</span>
                ) : (
                  <span className="t-meta">非 Git · 本地目录</span>
                )}
              </span>
            </span>
            <span className="chat-project-card-cta">
              <MessageSquare size={13} /> 进入对话
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
