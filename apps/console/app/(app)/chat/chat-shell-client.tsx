"use client";

import type { Project, Worker } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "../../ui/chat";

// 实时对话总外壳（/chat 与 /chat/[projectId] 共用）：拉一次 projects + workers，
// 然后把项目树 + 会话历史 + 消息线交给 ChatView 渲染。
// URL ↔ 内部态：本组件不持有 expanded/active，而是把它们映射到 URL（pathname + ?c=）
// 让刷新 / 后退 / 分享天然还原；ChatView 内部只复用一份 React 态。
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [pr, wr] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" })
      ]);
      if (pr.ok) setProjects(((await pr.json()) as { projects: Project[] }).projects);
      if (wr.ok) setWorkers(((await wr.json()) as { workers: Worker[] }).workers);
    } catch {
      // 单次失败忽略，下次新建对话面板挂载会再触发一次。
    }
  }, []);

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
      projects={projects}
      workers={workers}
      loaded={loaded}
      canCommand={canCommand}
      onRequestRefresh={refresh}
      onProjectChange={handleProjectChange}
      onConversationChange={handleConversationChange}
    />
  );
}
