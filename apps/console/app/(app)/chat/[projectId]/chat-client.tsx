"use client";

import type { Project, Worker } from "@claude-center/db";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatView } from "../../../ui/chat";

// 项目对话工作台容器：挂载取一次 /api/projects + /api/workers 供新建对话面板的项目/Worker 选择；
// 打开新建面板时再刷新一次拿到最新候选。会话列表 / 消息流由 ChatView 自轮询。
// 若 projectId 不在用户可访问范围内（404 / 隐藏），自动回退到 /chat 首页。
export default function ChatProjectClient({
  projectId,
  canCommand
}: {
  projectId: string;
  canCommand: boolean;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [resolved, setResolved] = useState(false);

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
    void refresh().finally(() => setResolved(true));
  }, [refresh]);

  // 项目载入完成且不在可见列表里（无权 / 已删）：兜底回到首页。
  useEffect(() => {
    if (!resolved) return;
    if (!projects.some((p) => p.id === projectId)) {
      router.replace("/chat");
    }
  }, [resolved, projects, projectId, router]);

  const project = projects.find((p) => p.id === projectId) ?? null;

  return (
    <ChatView
      project={project}
      projects={projects}
      workers={workers}
      canCommand={canCommand}
      onRequestRefresh={refresh}
      onBackToProjects={() => router.push("/chat")}
    />
  );
}
