"use client";

import type { Worker } from "@claude-center/db";
import { useState } from "react";
import { usePolling } from "../../lib/use-polling";
import { WorkersView } from "../../ui/workers";

// 执行机群页容器：轮询 /api/workers（纯展示，不再依赖任务列表）。
// canCommand 由服务端页面按 command.create 权限算好传入，决定卡片是否显示删除入口。
export default function WorkersClient({ canCommand }: { canCommand: boolean }) {
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

  // 删除成功后乐观移除，下一轮轮询再与库对齐。
  function handleDeleted(id: string) {
    setWorkers((prev) => prev.filter((w) => w.id !== id));
  }

  return <WorkersView workers={workers} canCommand={canCommand} onDeleted={handleDeleted} />;
}
