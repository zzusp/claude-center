"use client";

import type { Project, Task } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { postJson } from "../../ui/shared";
import { usePolling } from "../../lib/use-polling";
import { TasksView, TaskDrawer } from "../../ui/tasks";

// 任务调度页容器：列表由 TasksView 自轮询 /api/tasks（分页）；本容器另轮询 /api/projects（筛选/表单）
// 与候选任务（依赖选择，取最近 100 条），并承载「发布任务」抽屉与创建逻辑（原 Dashboard.handleTaskSubmit）。
export default function TasksClient({ canCreateTask }: { canCreateTask: boolean }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [candidateTasks, setCandidateTasks] = useState<Task[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  usePolling(async (isActive) => {
    try {
      const [pr, tr] = await Promise.all([
        fetch("/api/projects", { cache: "no-store" }),
        fetch("/api/tasks?pageSize=100", { cache: "no-store" })
      ]);
      if (!isActive()) return;
      if (pr.ok) {
        const data = (await pr.json()) as { projects: Project[] };
        setProjects(data.projects);
        setSelectedProjectId((current) => current || data.projects[0]?.id || "");
      }
      if (tr.ok) {
        const data = (await tr.json()) as { tasks: Task[] };
        setCandidateTasks(data.tasks);
      }
    } catch {
      // 轮询兜底，单次失败忽略
    }
  }, []);

  async function handleTaskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    // datetime-local 取到的是本地时间（无时区），转 ISO（带时区）再发；留空即非定时任务。
    const scheduledLocal = String(data.get("scheduledAt") ?? "").trim();
    const scheduledAt = scheduledLocal ? new Date(scheduledLocal).toISOString() : undefined;
    setBusy(true);
    setSubmitError(null);
    try {
      // 多仓任务：表单里 hidden taskRepos 字段是 JSON 序列化的子仓启用清单（仅 enabled=true 的子仓被包含）。
      // 主仓的 base/work/target 仍走外层 baseBranch/workBranch/targetBranch；后端补主仓行并把未启用子仓落 'skipped'。
      let taskRepos: unknown = undefined;
      try {
        const raw = String(data.get("taskRepos") ?? "").trim();
        taskRepos = raw ? JSON.parse(raw) : undefined;
      } catch {
        taskRepos = undefined;
      }
      await postJson("/api/tasks", {
        projectId: selectedProjectId,
        title: data.get("title"),
        description: data.get("description"),
        baseBranch: data.get("baseBranch"),
        workBranch: data.get("workBranch"),
        targetBranch: data.get("targetBranch"),
        submitMode: data.get("submitMode"),
        autoMergePr: data.get("autoMergePr") === "on",
        autoReply: data.get("autoReply") === "on",
        autoDecisionHints: String(data.get("autoDecisionHints") ?? ""),
        model: data.get("model"),
        dependsOn: data.getAll("dependsOn").map(String),
        scheduledAt,
        taskRepos
      });
      form.reset();
      setDrawerOpen(false);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TasksView
        projects={projects}
        onOpenTask={(task) => router.push(`/tasks/${task.id}`)}
        onOpenCompose={() => {
          setSubmitError(null);
          setDrawerOpen(true);
        }}
        canCreateTask={canCreateTask}
      />
      <TaskDrawer
        open={drawerOpen}
        busy={busy}
        submitError={submitError}
        projects={projects}
        candidateTasks={candidateTasks}
        selectedProjectId={selectedProjectId}
        onClose={() => setDrawerOpen(false)}
        onSelectProject={setSelectedProjectId}
        onSubmitTask={handleTaskSubmit}
        canCreateTask={canCreateTask}
      />
    </>
  );
}
