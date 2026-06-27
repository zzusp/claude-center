"use client";

import type { Project } from "@claude-center/db";
import { useEffect, useState } from "react";
import { ChatProjectsView } from "../../ui/chat-projects";

// 实时对话首页（项目网格）：挂载即拉一次 /api/projects 渲染卡片；不订阅 relay、不周期轮询——
// 进入项目工作台后由 /chat/[projectId] 自行维护实时数据通道。
export default function ChatProjectsClient({ canCommand }: { canCommand: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/projects", { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "项目加载失败");
        }
        const d = (await r.json()) as { projects: Project[] };
        if (!cancelled) {
          setProjects(d.projects);
          setLoaded(true);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "项目加载失败");
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <ChatProjectsView projects={projects} loaded={loaded} error={error} canCommand={canCommand} />;
}
