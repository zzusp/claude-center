"use client";

import type { Task, TaskPredecessor, TaskRepo } from "@claude-center/db";
import { Activity, Check, FileText, GitPullRequest, Info, ListChecks, RotateCcw } from "lucide-react";
import { Empty, KvRow, StatusBadge, fmtTime, postJson } from "./shared";
import { Section, type LifecycleStep } from "./task-detail-shared";
import { useAsyncAction } from "../lib/use-async-action";
import { useState } from "react";

// 概览 Tab：高亮验收行（success 态） + 描述/错误 + 信息 + 前置任务 + 多仓 PR 表。
export function OverviewTab({
  task,
  taskRepos,
  lifecycle,
  modelLabel,
  depIds,
  preById,
  canReview,
  onReviewed
}: {
  task: Task;
  taskRepos: TaskRepo[];
  lifecycle: LifecycleStep[];
  modelLabel: string;
  depIds: string[];
  preById: Map<string, TaskPredecessor>;
  canReview: boolean;
  onReviewed: () => void | Promise<void>;
}) {
  // 多仓：active 仓 > 1 时改用多仓 PR 表；单仓仍走老 KvRow PR 单条（向后兼容观感）。
  const activeRepos = taskRepos.filter((r) => r.sub_status !== "skipped");
  const isMultiRepo = activeRepos.length > 1;
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

        {isMultiRepo ? (
          <Section icon={<GitPullRequest size={15} />} title="多仓 PR / 提交状态">
            <MultiRepoTable taskRepos={taskRepos} />
          </Section>
        ) : null}

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
            {task.pr_url && !isMultiRepo ? (
              <KvRow
                k="PR"
                v={
                  <a href={task.pr_url} target="_blank" rel="noreferrer">
                    {task.pr_url}
                  </a>
                }
              />
            ) : null}
            {isMultiRepo ? <KvRow k="参与仓" v={`${activeRepos.length} 个（详见左侧表格）`} /> : null}
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

// 多仓 PR 表：每行展示仓名 / 子状态 / base→target / PR / 错误。
function MultiRepoTable({ taskRepos }: { taskRepos: TaskRepo[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>仓</th>
            <th>状态</th>
            <th>分支</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {taskRepos.map((r) => (
            <tr key={r.id}>
              <td>
                <div className="cell-stack">
                  <span className="t-title">{r.role === "main" ? "主仓" : r.relative_path}</span>
                  {r.role === "sub" ? <span className="t-meta mono">{r.relative_path}</span> : null}
                </div>
              </td>
              <td>
                <span className="tag">{subStatusLabel(r.sub_status)}</span>
                {r.error_message ? (
                  <div className="t-meta" style={{ color: "var(--danger, #d33)" }}>{r.error_message.slice(0, 200)}</div>
                ) : null}
              </td>
              <td className="mono" style={{ fontSize: "0.85em" }}>
                {r.work_branch || "—"} → {r.target_branch || "—"}
              </td>
              <td>
                {r.pr_url ? (
                  <a href={r.pr_url} target="_blank" rel="noreferrer">PR</a>
                ) : (
                  <span className="t-meta">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function subStatusLabel(s: TaskRepo["sub_status"]): string {
  switch (s) {
    case "pending": return "待执行";
    case "no_changes": return "无改动";
    case "committed": return "已提交";
    case "pushed": return "已推送";
    case "pr_created": return "PR 已建";
    case "pr_merged": return "PR 已合并";
    case "skipped": return "跳过";
    case "failed": return "失败";
    default: return s;
  }
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
