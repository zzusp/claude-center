"use client";

import type { Project, Task } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { postJson } from "../../ui/shared";
import { usePolling } from "../../lib/use-polling";
import { TasksView, TaskComposeModal } from "../../ui/tasks";

// 任务调度页容器：列表由 TasksView 自轮询 /api/tasks（分页）；本容器另拉 /api/projects（筛选/表单），
// 候选任务（依赖选择）在抽屉打开时才按需拉，避免与 TasksView 的主列表重复调 /api/tasks。
export default function TasksClient({ canCreateTask }: { canCreateTask: boolean }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [candidateTasks, setCandidateTasks] = useState<Task[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 发布任务后立即触发 TasksView 列表重拉（列表 usePolling 间隔为 Infinity，需要外部信号）。
  const [refreshSignal, setRefreshSignal] = useState(0);

  // 项目下拉：低频变化，挂载拉一次即可。
  usePolling(async (isActive) => {
    try {
      const pr = await fetch("/api/projects", { cache: "no-store" });
      if (!isActive()) return;
      if (pr.ok) {
        const data = (await pr.json()) as { projects: Project[] };
        setProjects(data.projects);
        setSelectedProjectId((current) => current || data.projects[0]?.id || "");
      }
    } catch {
      // 单次失败忽略
    }
  }, [], Infinity);

  // 候选任务（"发布任务"抽屉里的依赖任务下拉）：仅在抽屉打开时才拉，避免与 TasksView 的主列表双调 /api/tasks。
  useEffect(() => {
    if (!drawerOpen) return;
    let active = true;
    void fetch("/api/tasks?pageSize=100", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tasks: Task[] }>) : null))
      .then((data) => { if (active && data) setCandidateTasks(data.tasks); })
      .catch(() => {});
    return () => { active = false; };
  }, [drawerOpen]);

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
      // 附件 id 列表：tasks-compose 的 hidden input 序列化为 JSON 数组（spec docs/spec/task-attachments.md）。
      let attachmentIds: string[] = [];
      try {
        const raw = String(data.get("attachmentIds") ?? "").trim();
        const parsed = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
          attachmentIds = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        attachmentIds = [];
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
        dynamicWorkflow: data.get("dynamicWorkflow") === "on",
        dependsOn: data.getAll("dependsOn").map(String),
        scheduledAt,
        taskRepos,
        attachmentIds
      });
      form.reset();
      setDrawerOpen(false);
      setRefreshSignal((prev) => prev + 1);
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
        refreshSignal={refreshSignal}
      />
      <TaskComposeModal
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
