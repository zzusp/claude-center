"use client";

import type { Task } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { usePolling } from "../lib/use-polling";
import { DashboardView } from "../ui/overview";
import { emptyOverview, SPARK_CAP, type Overview } from "../ui/dashboard-shared";

// 总览页容器：轮询 /api/dashboard（summary/workers/tasks/health）；本地累积 sparkline 历史、
// 派生任务状态分布。心跳同步态独立于侧边栏 Shell 的 /api/summary 轮询。
export default function DashboardClient() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [history, setHistory] = useState<Record<"online" | "pending" | "running" | "failed", number[]>>({
    online: [],
    pending: [],
    running: [],
    failed: []
  });
  const [synced, setSynced] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) {
        if (isActive()) setSynced(false);
        return;
      }
      const data = (await response.json()) as Overview;
      if (!isActive()) return;
      setOverview(data);
      setHistory((prev) => ({
        online: [...prev.online, data.summary.onlineWorkers].slice(-SPARK_CAP),
        pending: [...prev.pending, data.summary.pendingTasks].slice(-SPARK_CAP),
        running: [...prev.running, data.summary.runningTasks].slice(-SPARK_CAP),
        failed: [...prev.failed, data.summary.failedTasks].slice(-SPARK_CAP)
      }));
      setSynced(true);
      setLastSyncAt(new Date().toISOString());
    } catch {
      if (isActive()) setSynced(false);
    }
  }, []);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const task of overview.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, [overview.tasks]);

  return (
    <DashboardView
      overview={overview}
      history={history}
      statusCounts={statusCounts}
      synced={synced}
      lastSyncAt={lastSyncAt}
      onOpenTask={(task: Task) => router.push(`/tasks/${task.id}`)}
    />
  );
}
