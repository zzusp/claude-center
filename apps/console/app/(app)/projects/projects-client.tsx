"use client";

import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { ProjectsView, type ProjectListItem } from "../../ui/projects";

// 代码项目页容器：挂载拉一次 /api/projects；mutation 后 onChanged 立即重拉。
// 列表项附带 subRepos（GET /api/projects 一次聚合），避免列表渲染再 N+1 查子仓。
export default function ProjectsClient({ canManageProjects }: { canManageProjects: boolean }) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);

  async function load(isActive: () => boolean = () => true): Promise<void> {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { projects: ProjectListItem[] };
      if (!isActive()) return;
      setProjects(data.projects);
    } catch {
      // 单次失败忽略
    }
  }

  usePolling((isActive) => {
    void load(isActive);
  }, [], Infinity);

  return <ProjectsView projects={projects} onChanged={() => load()} canManageProjects={canManageProjects} />;
}
