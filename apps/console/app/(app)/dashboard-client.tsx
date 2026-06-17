"use client";

import type { Task } from "@claude-center/db";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { usePolling } from "../lib/use-polling";
import { DashboardView } from "../ui/overview";
import { emptyOverview, SPARK_CAP, type Overview } from "../ui/dashboard-shared";

// 总览页容器：轮询 /api/dashboard（summary/workers/tasks/health）；本地累积 sparkline 历史、
// 派生任务状态分布。
export default function DashboardClient() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  // 四张卡的 sparkline 现在分两类：在线 Worker 仍是浏览器侧 15s × 24 点的 6 分钟窗口累积；
  // 今日新任务 / 今日完成 / 今日合并 都走后端 daily* 字段（真实 7 日历史）。
  const [history, setHistory] = useState<Record<"online", number[]>>({
    online: []
  });
  const [synced, setSynced] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  // 首次成功响应前不渲染 emptyOverview 派生出的"未连接 / 未启动 / 失败任务 0"（会被误读为系统异常），由下游骨架兜底。
  const [loaded, setLoaded] = useState(false);

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
        online: [...prev.online, data.summary.onlineWorkers].slice(-SPARK_CAP)
      }));
      setSynced(true);
      setLastSyncAt(new Date().toISOString());
      setLoaded(true);
    } catch {
      if (isActive()) setSynced(false);
    }
  }, [], 15000);

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
      loaded={loaded}
      onOpenTask={(task: Task) => router.push(`/tasks/${task.id}`)}
    />
  );
}
