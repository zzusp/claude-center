"use client";

import type { Project, Worker } from "@claude-center/db";
import { useCallback, useEffect, useState } from "react";
import { ChatView } from "../../ui/chat";

// 实时对话页容器：挂载取一次 /api/projects + /api/workers 供新建对话面板的项目/Worker 选择；
// 打开新建面板时再刷新一次拿到最新候选——它们与消息流无关，不订阅 relay、不周期轮询。
// 会话列表由 ChatView 自轮询 /api/conversations。
export default function ChatClient({ canCommand }: { canCommand: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [pr, wr] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/workers", { cache: "no-store" })
      ]);
      if (pr.ok) setProjects(((await pr.json()) as { projects: Project[] }).projects);
      if (wr.ok) setWorkers(((await wr.json()) as { workers: Worker[] }).workers);
    } catch {
      // 单次失败忽略
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <ChatView projects={projects} workers={workers} canCommand={canCommand} onRequestRefresh={refresh} />;
}
