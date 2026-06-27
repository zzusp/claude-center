"use client";

import type { Conversation, Project, Worker } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatView } from "../../ui/chat";

type ProjectWithConversations = Project & { conversations?: Conversation[] };

// 实时对话总外壳（/chat 与 /chat/[projectId] 共用）：拉一次 projects(+conversations) + workers，
// 然后把项目树 + 会话历史 + 消息线交给 ChatView 渲染。
// URL ↔ 内部态：本组件不持有 expanded/active，而是把它们映射到 URL（pathname + ?c=）
// 让刷新 / 后退 / 分享天然还原；ChatView 内部只复用一份 React 态。
//
// projects 走 `?include=conversations`：进页面一次性把所有项目的会话清单取齐，左侧项目树展开
// 即显，不再触发 /api/conversations?projectId=X 拉取，去掉首次展开时的「加载中…」闪烁。
// 展开后 ChatView 仍按 POLL_INTERVAL_MS 拉「当前展开项目」的对话刷新 generating / 最后消息时间。
export default function ChatShellClient({
  initialProjectId,
  initialConversationId,
  canCommand
}: {
  initialProjectId: string | null;
  initialConversationId: string | null;
  canCommand: boolean;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectWithConversations[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [pr, wr] = await Promise.all([
        fetch("/api/projects?include=conversations", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" })
      ]);
      if (pr.ok) {
        setProjects(((await pr.json()) as { projects: ProjectWithConversations[] }).projects);
      }
      if (wr.ok) setWorkers(((await wr.json()) as { workers: Worker[] }).workers);
    } catch {
      // 单次失败忽略，下次新建对话面板挂载会再触发一次。
    }
  }, []);

  // 项目附带的 conversations 字段提取出来按 projectId 索引，喂给 ChatView 做「展开即显」。
  // 字段从展示 Project 里剥离（避免污染下游消费 Project 的组件）。
  const { sanitizedProjects, conversationsByProject } = useMemo(() => {
    const byProject: Record<string, Conversation[]> = {};
    const cleaned: Project[] = projects.map((p) => {
      const { conversations, ...rest } = p;
      if (conversations) byProject[p.id] = conversations;
      return rest as Project;
    });
    return { sanitizedProjects: cleaned, conversationsByProject: byProject };
  }, [projects]);

  useEffect(() => {
    void refresh().finally(() => setLoaded(true));
  }, [refresh]);

  function handleProjectChange(projectId: string | null): void {
    if (projectId) {
      router.replace(`/chat/${projectId}`);
    } else {
      router.replace("/chat");
    }
  }

  function handleConversationChange(projectId: string, conversationId: string | null): void {
    if (conversationId) {
      router.replace(`/chat/${projectId}?c=${conversationId}`);
    } else {
      router.replace(`/chat/${projectId}`);
    }
  }

  return (
    <ChatView
      initialProjectId={initialProjectId}
      initialConversationId={initialConversationId}
      projects={sanitizedProjects}
      conversationsByProject={conversationsByProject}
      workers={workers}
      loaded={loaded}
      canCommand={canCommand}
      onRequestRefresh={refresh}
      onProjectChange={handleProjectChange}
      onConversationChange={handleConversationChange}
    />
  );
}
