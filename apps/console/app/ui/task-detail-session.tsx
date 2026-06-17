"use client";

import type { AttachmentMeta, Task, Worker } from "@claude-center/db";
import { ScrollText, Send } from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { Empty, fmtTime } from "./shared";
import { SessionMetaBar } from "./session-meta";
import { TranscriptView, parseTranscript } from "./transcript";
import { usePolling } from "../lib/use-polling";
import { useAsyncAction } from "../lib/use-async-action";
import { AttachmentUploader } from "./attachment-uploader";

// 任务执行会话回放 + 续接回复入口（原「对话」Tab 合并入此）。
// transcript：执行期间（claimed/running/waiting）每 5s 懒轮询，终态后再取数次拿到 Worker 最终强制同步的
// 完整 transcript 即停拉（避免持续拖大 blob）。Worker 周期 + 终态把 session .jsonl 同步到 task_sessions。
// 回复表单：waiting 时启用；提交落 task_comments → Worker 下一轮 --resume 注入 prompt → 再回到 jsonl 渲染。
// 解析 + 富展示走共用 transcript.tsx（与对话页同款）。
// 顶部 SessionMetaBar 复用对话页同款：通道 + 模型 + Worker 套餐 / 用量 + 上下文 / 会话累计 token。
// worker 由父组件 /api/tasks/[id] polling 顺路带回（未认领时为 null，meta bar 自适应隐藏 worker chip）。
export function SessionTranscript({
  task,
  worker,
  canComment
}: {
  task: Task;
  worker: Worker | null;
  canComment: boolean;
}) {
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
      <ReplyForm task={task} canComment={canComment} />
    </div>
  );
}

// 续接回复表单：在「在途」态（claimed / running / waiting）均启用输入——用户可随时发送消息给 Worker，
// 不必等 Worker 显式提问。提交落一条 user 评论到 task_comments，Worker 下一轮认领循环
// （claimNextResumableTask + getPendingReply）会把「自上一次 resumed/rerun_started 事件以来」的
// 所有 user 评论一并注入 --resume 的 prompt，再回到 jsonl 渲染——running 期间提交的消息也不会被
// 同轮新生的 worker question 覆盖。附件上传走通用 AttachmentUploader，提交后清空本地状态。
function ReplyForm({ task, canComment }: { task: Task; canComment: boolean }) {
  const [reply, setReply] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<AttachmentMeta[]>([]);
  const { busy, error, run } = useAsyncAction();
  // 在途态：worker 正在/即将处理本任务，发送的消息会在下一次 resume 时被消费。
  const live = task.status === "claimed" || task.status === "running" || task.status === "waiting";
  const canReply = live && canComment;

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reply.trim() && replyAttachments.length === 0) return;
    await run(async () => {
      const response = await fetch(`/api/tasks/${task.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: reply.trim(),
          attachmentIds: replyAttachments.map((a) => a.id)
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `回复失败：${response.status}`);
      }
      setReply("");
      setReplyAttachments([]);
    });
  }

  return (
    <form className="chat-input" onSubmit={submitReply}>
      <textarea
        rows={3}
        value={reply}
        onChange={(event) => setReply(event.target.value)}
        placeholder={
          !canComment
            ? "你没有任务对话权限"
            : live
              ? task.status === "waiting"
                ? "回复 Worker 的提问，提交后将续接执行…"
                : "随时给 Worker 留言，下一轮续接时一并注入…"
              : "任务未在执行中，无法发送消息"
        }
        disabled={!canReply || busy}
      />
      {canReply ? (
        <AttachmentUploader
          attachments={replyAttachments}
          onChange={setReplyAttachments}
          disabled={busy}
        />
      ) : null}
      {error ? <div className="error-box">{error}</div> : null}
      <div className="chat-actions">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!canReply || busy || (!reply.trim() && replyAttachments.length === 0)}
        >
          <Send size={16} />
          {!canComment ? "无回复权限" : live ? (task.status === "waiting" ? "回复并续接" : "发送消息") : "任务非在途"}
        </button>
      </div>
    </form>
  );
}
