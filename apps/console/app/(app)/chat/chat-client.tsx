"use client";

import type { Project, Worker } from "@claude-center/db";
import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { ChatView } from "../../ui/chat";

// 实时对话页容器：轮询 /api/projects + /api/workers 供新建对话的项目/在线 Worker 选择；
// 会话列表由 ChatView 自轮询 /api/conversations。
export default function ChatClient({ canCommand }: { canCommand: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);

  usePolling(async (isActive) => {
    try {
      const [pr, wr] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" })
      ]);
      if (!isActive()) return;
      if (pr.ok) setProjects(((await pr.json()) as { projects: Project[] }).projects);
      if (wr.ok) setWorkers(((await wr.json()) as { workers: Worker[] }).workers);
    } catch {
      // 轮询兜底，单次失败忽略
    }
  }, []);

  return <ChatView projects={projects} workers={workers} canCommand={canCommand} />;
}
