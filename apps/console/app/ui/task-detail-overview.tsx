"use client";

import type { Task, TaskPredecessor } from "@claude-center/db";
import { Activity, Check, FileText, Info, ListChecks, RotateCcw } from "lucide-react";
import { Empty, KvRow, StatusBadge, fmtTime, postJson } from "./shared";
import { Section, type LifecycleStep } from "./task-detail-shared";
import { useAsyncAction } from "../lib/use-async-action";
import { useState } from "react";

// 概览 Tab：高亮验收行（success 态） + 描述/错误 + 信息 + 前置任务。
export function OverviewTab({
  task,
  lifecycle,
  modelLabel,
  depIds,
  preById,
  canReview,
  onReviewed
}: {
  task: Task;
  lifecycle: LifecycleStep[];
  modelLabel: string;
  depIds: string[];
  preById: Map<string, TaskPredecessor>;
  canReview: boolean;
  onReviewed: () => void | Promise<void>;
}) {
  return (
    <div className="detail-grid">
      <div className="detail-main">
        {canReview ? (
          <section className="card detail-section">
            <div className="section-body">
              <TaskReviewActions task={task} onReviewed={onReviewed} />
            </div>
          </section>
        ) : null}

        <Section icon={<FileText size={15} />} title="任务描述">
          <p className="detail-desc">{task.description || "（无描述）"}</p>
          {task.error_message ? <div className="error-box">{task.error_message}</div> : null}
        </Section>

        <Section icon={<Activity size={15} />} title="执行进度">
          <div className="lifecycle-bar">
            {lifecycle.map((item, index) => (
              <div className={`lc-step ${item.state}`} key={`lc-${index}`}>
                <span className="lc-node" />
                <div className="lc-text">
                  <div className="lc-label">{item.label}</div>
                  <div className="lc-time">{item.time ? fmtTime(item.time) : "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <aside className="detail-side">
        <Section icon={<Info size={15} />} title="信息">
          <div className="kv">
            <KvRow k="项目" v={task.project_name ?? task.project_id} />
            <KvRow k="签出分支" v={task.base_branch} mono />
            <KvRow k="工作分支" v={task.work_branch} mono />
            <KvRow k="目标分支" v={task.target_branch} mono />
            <KvRow k="提交模式" v={task.submit_mode === "push" ? "直接提交推送" : "创建 PR"} />
            {task.submit_mode === "pr" ? (
              <KvRow k="自动合并 PR" v={task.auto_merge_pr ? "是 · 创建后自动合并" : "否"} />
            ) : null}
            <KvRow k="自动回复" v={task.auto_reply ? "是 · 无人值守兜底（cap=2）" : "否"} />
            {task.auto_reply && task.auto_decision_hints ? (
              <KvRow k="决策预案" v={task.auto_decision_hints} />
            ) : null}
            <KvRow k="执行模型" v={modelLabel} />
            <KvRow k="Worker" v={task.worker_name ?? "—"} />
            <KvRow k="Session ID" v={task.claude_session_id ?? "—"} mono />
            {task.pr_url ? (
              <KvRow
                k="PR"
                v={
                  <a href={task.pr_url} target="_blank" rel="noreferrer">
                    {task.pr_url}
                  </a>
                }
              />
            ) : null}
            {task.scheduled_at ? (
              <KvRow
                k="定时发布"
                v={
                  task.status === "scheduled"
                    ? `${fmtTime(task.scheduled_at)}（到点自动进入待处理）`
                    : fmtTime(task.scheduled_at)
                }
              />
            ) : null}
            <KvRow k="创建于" v={fmtTime(task.created_at)} />
            <KvRow k="更新于" v={fmtTime(task.updated_at)} />
          </div>
        </Section>

        {depIds.length > 0 ? (
          <Section icon={<ListChecks size={15} />} title="前置任务">
            <div className="dep-list">
              {depIds.map((id, index) => {
                const pre = preById.get(id);
                return pre ? (
                  <a className="dep-item" href={`/tasks/${pre.id}`} key={pre.id}>
                    <StatusBadge status={pre.status} />
                    <span className="dep-title">{pre.title}</span>
                  </a>
                ) : (
                  <span className="dep-item is-gone" key={index}>
                    <span className="badge" data-tone="cancelled">已删除任务</span>
                  </span>
                );
              })}
            </div>
          </Section>
        ) : null}
      </aside>
    </div>
  );
}

// 人工验收操作：accept / reject（打回需填意见，Worker 续接重跑）。
function TaskReviewActions({ task, onReviewed }: { task: Task; onReviewed: () => void | Promise<void> }) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const { busy, error, setError, run } = useAsyncAction();

  async function review(action: "accept" | "reject") {
    if (action === "reject" && !feedback.trim()) {
      setError("打回必须填写意见");
      return;
    }
    await run(async () => {
      await postJson(`/api/tasks/${task.id}/review`, {
        action,
        feedback: action === "reject" ? feedback.trim() : undefined
      });
      setRejecting(false);
      setFeedback("");
      await onReviewed();
    });
  }

  return (
    <div className="review-actions">
      <div className="review-hint">该任务已执行完成，待人工验收。</div>
      {rejecting ? (
        <>
          <textarea
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="填写打回意见，Worker 将带着该意见续接重跑…"
            disabled={busy}
          />
          <div className="review-btns">
            <button className="btn btn-sm" type="button" onClick={() => setRejecting(false)} disabled={busy}>
              取消
            </button>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => review("reject")}
              disabled={busy || !feedback.trim()}
            >
              <RotateCcw size={15} />
              确认打回
            </button>
          </div>
        </>
      ) : (
        <div className="review-btns">
          <button className="btn btn-primary btn-sm" type="button" onClick={() => review("accept")} disabled={busy}>
            <Check size={15} />
            验收通过
          </button>
          <button className="btn btn-sm" type="button" onClick={() => setRejecting(true)} disabled={busy}>
            <RotateCcw size={15} />
            打回重跑
          </button>
        </div>
      )}
      {error ? <div className="error-box">{error}</div> : null}
    </div>
  );
}
