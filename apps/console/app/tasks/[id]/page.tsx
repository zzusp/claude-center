import { getPool, getTaskProjectId, getTaskWithDeps, userHasProject } from "@claude-center/db";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, toCurrentUser } from "../../lib/session";
import TaskDetailPage from "../../ui/task-detail";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const { id } = await params;

  // 项目隔离：非 admin 越权访问 → 视作不存在。
  if (user.role !== "admin") {
    const projectId = await getTaskProjectId(getPool(), id);
    if (!projectId || !(await userHasProject(getPool(), user.id, projectId))) {
      notFound();
    }
  }

  const detail = await getTaskWithDeps(getPool(), id);
  if (!detail) {
    notFound();
  }

  const current = toCurrentUser(user);
  return (
    <TaskDetailPage
      initialTask={detail.task}
      initialPredecessors={detail.predecessors}
      canCreateTask={current.permissions.includes("task.create")}
      canComment={current.permissions.includes("task.comment")}
    />
  );
}
