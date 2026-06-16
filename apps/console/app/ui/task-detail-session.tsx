"use client";

import type { Task, Worker } from "@claude-center/db";
import { ScrollText } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Empty, fmtTime } from "./shared";
import { SessionMetaBar } from "./session-meta";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";

// 任务执行会话回放：执行期间（claimed/running/waiting）每 5s 懒轮询，终态后再取数次拿到 Worker 最终强制同步的
// 完整 transcript 即停拉（避免持续拖大 blob）。Worker 周期 + 终态把 session .jsonl 同步到 task_sessions。
// 解析 + 富展示走共用 transcript.tsx（与对话页同款）。
// 顶部 SessionMetaBar 复用对话页同款：通道 + 模型 + Worker 套餐 / 用量 + 上下文 / 会话累计 token。
// worker 由父组件 /api/tasks/[id] polling 顺路带回（未认领时为 null，meta bar 自适应隐藏 worker chip）。
export function SessionTranscript({ task, worker }: { task: Task; worker: Worker | null }) {
  const [jsonl, setJsonl] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const doneRef = useRef(false);
  const termCountRef = useRef(0);
  const live = task.status === "claimed" || task.status === "running" || task.status === "waiting";

  usePolling(
    async (isActive) => {
      // 终态且已取够最终版（覆盖 Worker 终态强制同步的小窗）后停拉，不再重复拉大 blob。
      if (doneRef.current) return;
      try {
        const response = await fetch(`/api/tasks/${task.id}/session`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { jsonl: string | null; syncedAt: string | null };
        if (!isActive()) return;
        setJsonl(data.jsonl);
        setSyncedAt(data.syncedAt);
        setLoaded(true);
        if (!live) {
          termCountRef.current += 1;
          if (termCountRef.current >= 3) doneRef.current = true;
        }
      } catch {
        /* 轮询失败静默，下次重试 */
      }
    },
    [task.id, live],
    5000
  );

  const items = useMemo(() => (jsonl ? parseTranscript(jsonl) : []), [jsonl]);

  // meta bar 任何状态都展示（即便 jsonl 还没拉到也能看到通道 / 模型 / worker 信息），仅 transcript 区随
  // loaded / items 变化。jsonl 为 null 时 SessionMetaBar 会自动隐藏 token chip。
  return (
    <div className="tx-wrap">
      <SessionMetaBar planModel={task.model} worker={worker} jsonl={jsonl} />
      {!loaded ? (
        <Empty icon={<ScrollText size={28} />} text="加载中…" />
      ) : items.length === 0 ? (
        <Empty icon={<ScrollText size={28} />} text="暂无执行会话记录（Worker 执行后会同步到此）" />
      ) : (
        <TranscriptView items={items} />
      )}
      {syncedAt ? <div className="session-synced">最近同步：{fmtTime(syncedAt)}</div> : null}
    </div>
  );
}
