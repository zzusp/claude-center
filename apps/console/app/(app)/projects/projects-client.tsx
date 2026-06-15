"use client";

import type { Project } from "@claude-center/db";
import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { ProjectsView } from "../../ui/projects";

// 代码项目页容器：轮询 /api/projects；mutation 后 onChanged 立即重拉。
export default function ProjectsClient({ canManageProjects }: { canManageProjects: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);

  async function load(isActive: () => boolean = () => true): Promise<void> {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { projects: Project[] };
      if (!isActive()) return;
      setProjects(data.projects);
    } catch {
      // 轮询兜底，单次失败忽略
    }
  }

  usePolling((isActive) => {
    void load(isActive);
  }, []);

  return <ProjectsView projects={projects} onChanged={() => load()} canManageProjects={canManageProjects} />;
}
