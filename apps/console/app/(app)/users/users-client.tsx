"use client";

import type { Project } from "@claude-center/db";
import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { UsersView } from "../../ui/users";
import type { CurrentUser } from "../../ui/dashboard-shared";

// 用户权限页容器：挂载拉一次 /api/projects 供项目名映射/分配；用户列表由 UsersView 自拉 /api/users。
export default function UsersClient({ currentUser }: { currentUser: CurrentUser }) {
  const [projects, setProjects] = useState<Project[]>([]);

  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/projects", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { projects: Project[] };
      if (!isActive()) return;
      setProjects(data.projects);
    } catch {
      // 单次失败忽略
    }
  }, [], Infinity);

  return <UsersView projects={projects} currentUser={currentUser} />;
}
