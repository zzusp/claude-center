"use client";

import type { Worker } from "@claude-center/db";
import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { WorkersView } from "../../ui/workers";

// 执行机群页容器：轮询 /api/workers（纯展示，不再依赖任务列表）。
export default function WorkersClient() {
  const [workers, setWorkers] = useState<Worker[]>([]);

  usePolling(async (isActive) => {
    try {
      const response = await fetch("/api/workers", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { workers: Worker[] };
      if (!isActive()) return;
      setWorkers(data.workers);
    } catch {
      // 轮询兜底，单次失败忽略
    }
  }, []);

  return <WorkersView workers={workers} />;
}
