"use client";

import type { ReactNode } from "react";
import type { Task, TaskComment, TaskEvent, TaskPredecessor, TaskRepo } from "@claude-center/db";
import {
  Activity,
  Bot,
  ClipboardList,
  FileCode,
  FileText,
  GitBranch,
  GitPullRequest,
  Info,
  Link2,
  ListChecks,
  Maximize2,
  Type,
  UserRound
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { KvRow, StatusBadge, fmtDateTime, isPendingSubRepoPath } from "./shared";
import { FormModal } from "./controls";
import { AttachmentList } from "./attachment-uploader";
import { usePolling } from "../lib/use-polling";

// 概览 Tab:五张卡片，三列两行——
//   第一行:基本信息 / 进度 / 任务描述(右列跨两行)
//   第二行:相关信息 / 执行结果
// success 由 Console 30s 轮询检测 PR 合并自动翻 merged。
// 多仓 PR 表 / 前置任务为少数任务才有的补充信息,放在五卡之下按需渲染(不污染五卡固定结构)。
export function OverviewTab({
  task,
  taskRepos,
  events,
  modelLabel,
  depIds,
  preById
}: {
  task: Task;
  taskRepos: TaskRepo[];
  events: TaskEvent[];
  modelLabel: string;
  depIds: string[];
  preById: Map<string, TaskPredecessor>;
}) {
  // claude 的提问(worker 评论)与用户的答复(user 评论):概览常驻 tab,懒轮询拉取,有数据才展示。
  const [comments, setComments] = useState<TaskComment[]>([]);
  usePolling(
    async (isActive) => {
      try {
        const response = await fetch(`/api/tasks/${task.id}/comments`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { comments: TaskComment[] };
        if (isActive()) setComments(data.comments ?? []);
      } catch {
        /* 轮询失败静默,下次重试 */
      }
    },
    [task.id]
  );

  const activeRepos = taskRepos.filter((r) => r.sub_status !== "skipped");
  const isMultiRepo = activeRepos.length > 1;

  const progress = buildProgress(task, events);

  return (
    <div className="overview-grid">
      <div className="ov-left">
        <OvCard icon={<Info size={15} />} title="基本信息">
          <div className="kv">
            <KvRow k="任务 ID" v={task.id} mono />
            <KvRow k="项目" v={task.project_name ?? task.project_id} />
            <KvRow k="签出分支" v={task.base_branch} mono />
            <KvRow k="工作分支" v={task.work_branch} mono />
            <KvRow k="目标分支" v={task.target_branch} mono />
            <KvRow k="提交模式" v={task.submit_mode === "push" ? "直接提交推送" : "创建 PR"} />
            {task.submit_mode === "pr" ? (
              <KvRow k="自动合并 PR" v={task.auto_merge_pr ? "是 · 创建后自动合并" : "否"} />
            ) : null}
            <KvRow k="自动回复" v={task.auto_reply ? "是 · 无人值守兜底（cap=2）" : "否"} />
            <KvRow k="执行模型" v={modelLabel} />
            <KvRow k="定时任务" v={task.scheduled_at ? `${fmtDateTime(task.scheduled_at)} 发布` : "否"} />
            <KvRow k="前置任务" v={depIds.length > 0 ? `${depIds.length} 个` : "无"} />
          </div>
        </OvCard>

        <OvCard icon={<Activity size={15} />} title="进度" scroll>
          <ProgressPanel percent={progress.percent} nodes={progress.nodes} />
        </OvCard>

        <OvCard icon={<Link2 size={15} />} title="相关信息">
          <div className="kv">
            <KvRow k="Worker" v={task.worker_name ?? "—"} />
            <KvRow k="Session ID" v={task.claude_session_id ?? "—"} mono />
            <KvRow
              k="PR"
              v={
                task.pr_url ? (
                  <a className="ov-pr-link" href={task.pr_url} target="_blank" rel="noreferrer">
                    <GitBranch size={13} />
                    {prNumber(task.pr_url)}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <KvRow k="开始执行时间" v={fmtDateTime(task.started_at)} />
            <KvRow k={finishLabel(task.status)} v={fmtDateTime(task.finished_at)} />
          </div>
        </OvCard>

        <OvCard icon={<ClipboardList size={15} />} title="执行结果">
          <ResultPanel task={task} />
        </OvCard>
      </div>

      <OvCard className="ov-card--desc" icon={<FileText size={15} />} title="任务描述" scroll>
        <p className="detail-desc">{task.description || "（无描述）"}</p>
        {task.attachments && task.attachments.length > 0 ? (
          <AttachmentList attachments={task.attachments} />
        ) : null}
        {comments.length > 0 ? (
          <div className="ov-qa">
            <div className="ov-qa-head">对话记录</div>
            {comments.map((c) => (
              <div className={`ov-qa-item ${c.author}`} key={c.id}>
                <div className="ov-qa-meta">
                  {c.author === "worker" ? <Bot size={13} /> : <UserRound size={13} />}
                  <span className="ov-qa-who">{c.author === "worker" ? "Claude 提问" : "用户答复"}</span>
                  <span className="ov-qa-time">{fmtDateTime(c.created_at)}</span>
                </div>
                {c.body ? <div className="ov-qa-body">{c.body}</div> : null}
                {c.attachments && c.attachments.length > 0 ? (
                  <AttachmentList attachments={c.attachments} />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </OvCard>

      {isMultiRepo ? (
        <section className="card ov-card ov-card--full">
          <div className="ov-head">
            <span className="ov-ico">
              <GitPullRequest size={15} />
            </span>
            <h3 className="ov-title">多仓 PR / 提交状态</h3>
          </div>
          <div className="ov-body ov-body--static">
            <MultiRepoTable taskRepos={taskRepos} />
          </div>
        </section>
      ) : null}

      {depIds.length > 0 ? (
        <section className="card ov-card ov-card--full">
          <div className="ov-head">
            <span className="ov-ico">
              <ListChecks size={15} />
            </span>
            <h3 className="ov-title">前置任务</h3>
          </div>
          <div className="ov-body ov-body--static">
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
          </div>
        </section>
      ) : null}
    </div>
  );
}

// 概览卡片:统一卡头 + 卡体。scroll=true 时卡体绝对填充剩余高度并内部滚动——卡身高度由外层 grid
// 拉伸决定(进度卡随基本信息卡、任务描述卡随左侧两行总高),内容超出即出滚动条,绝对定位使内容不反向
// 撑高卡片(从而不影响行高计算)。
function OvCard({
  icon,
  title,
  scroll,
  className,
  children
}: {
  icon: ReactNode;
  title: string;
  scroll?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ov-card${className ? ` ${className}` : ""}`}>
      <div className="ov-head">
        <span className="ov-ico">{icon}</span>
        <h3 className="ov-title">{title}</h3>
      </div>
      {scroll ? (
        <div className="ov-scroll-region">
          <div className="ov-body">{children}</div>
        </div>
      ) : (
        <div className="ov-body ov-body--static">{children}</div>
      )}
    </section>
  );
}

type ProgressNode = { label: string; time: string | null; done: boolean };

// 进度面板:顶部百分比进度条 + 里程碑节点(左节点名、右时间)。
function ProgressPanel({ percent, nodes }: { percent: number; nodes: ProgressNode[] }) {
  return (
    <div className="ov-progress">
      <div className="ov-bar-head">
        <span className="ov-bar-label">完成度</span>
        <span className="ov-bar-pct">{percent}%</span>
      </div>
      <div className="ov-bar-track">
        <div className="ov-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="ov-bar-nodes">
        {nodes.map((n, i) => (
          <div className={`ov-node-row${n.done ? " is-done" : ""}`} key={`node-${i}`}>
            <span className="ov-node-dot" />
            <span className="ov-node-label">{n.label}</span>
            <span className="ov-node-time">{n.time ? fmtDateTime(n.time) : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 执行结果:成功/已合并显示「执行结果摘要」(result.claudeResult);失败/取消显示「错误说明」(error_message)。
function ResultPanel({ task }: { task: Task }) {
  const isFailed = task.status === "failed" || task.status === "cancelled";
  if (isFailed) {
    return (
      <div className="ov-result">
        <div className="ov-result-title">失败时的错误说明</div>
        {task.error_message ? (
          <div className="error-box">{task.error_message}</div>
        ) : (
          <div className="ov-result-empty">无错误说明</div>
        )}
      </div>
    );
  }
  const isDone = task.status === "success" || task.status === "merged";
  if (isDone) {
    const summary = typeof task.result?.claudeResult === "string" ? task.result.claudeResult : "";
    return summary ? (
      <ResultSummary summary={summary} />
    ) : (
      <div className="ov-result">
        <div className="ov-result-title">执行结果摘要</div>
        <div className="ov-result-empty">无结果摘要</div>
      </div>
    );
  }
  return <div className="ov-result-empty">任务尚未结束，暂无执行结果</div>;
}

// 执行结果摘要:支持 Markdown / 纯文本切换渲染,以及放大到弹窗内查看(卡内空间有限,长结果便于阅读)。
function ResultSummary({ summary }: { summary: string }) {
  const [asMarkdown, setAsMarkdown] = useState(true);
  const [zoomed, setZoomed] = useState(false);

  const body = (full: boolean) =>
    asMarkdown ? (
      <div className={`tx-text ov-result-md${full ? " is-full" : ""}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
      </div>
    ) : (
      <div className={`ov-result-text${full ? " is-full" : ""}`}>{summary}</div>
    );

  return (
    <div className="ov-result">
      <div className="ov-result-head">
        <div className="ov-result-title">执行结果摘要</div>
        <div className="ov-result-tools">
          <button
            type="button"
            className="ov-result-tool"
            onClick={() => setAsMarkdown((v) => !v)}
            title={asMarkdown ? "切换为纯文本" : "切换为 Markdown 渲染"}
          >
            {asMarkdown ? <Type size={13} /> : <FileCode size={13} />}
            {asMarkdown ? "纯文本" : "Markdown"}
          </button>
          <button type="button" className="ov-result-tool" onClick={() => setZoomed(true)} title="放大展示">
            <Maximize2 size={13} />
            放大
          </button>
        </div>
      </div>
      {body(false)}
      <FormModal open={zoomed} title="执行结果摘要" onClose={() => setZoomed(false)} size="xl">
        {body(true)}
      </FormModal>
    </div>
  );
}

// 进度里程碑:已创建 / 已认领 / 开始执行 / 执行结束 / 提交代码 /(PR 模式)已合并落地。
// 里程碑单调推进——取最远抵达节点,其前节点一并视作 done(补齐因事件缺失造成的空洞),
// 百分比 = (最远抵达序号 + 1) / 节点总数。
function buildProgress(task: Task, events: TaskEvent[]): { percent: number; nodes: ProgressNode[] } {
  const lastEventTime = (type: string): string | null => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]!.event_type === type) return events[i]!.created_at;
    }
    return null;
  };
  const firstEventTime = (types: string[]): string | null => {
    for (const e of events) {
      if (types.includes(e.event_type)) return e.created_at;
    }
    return null;
  };

  const execEnd =
    lastEventTime("claude_turn_finished") ??
    lastEventTime("success") ??
    lastEventTime("failed") ??
    lastEventTime("cancelled") ??
    task.finished_at;
  const committed = firstEventTime(["committed", "pushed", "pr_created"]);
  const merged = lastEventTime("merged") ?? lastEventTime("auto_merged");

  const raw: ProgressNode[] = [
    { label: "已创建", time: task.created_at, done: true },
    { label: "已认领", time: task.claimed_at, done: Boolean(task.claimed_at) },
    { label: "开始执行", time: task.started_at, done: Boolean(task.started_at) },
    { label: "执行结束", time: execEnd, done: Boolean(execEnd) },
    { label: "提交代码", time: committed, done: Boolean(committed) }
  ];
  if (task.submit_mode === "pr") {
    raw.push({ label: "已合并落地", time: merged, done: task.status === "merged" || Boolean(merged) });
  }

  let lastDone = -1;
  raw.forEach((n, i) => {
    if (n.done) lastDone = i;
  });
  const nodes = raw.map((n, i) => ({ ...n, done: i <= lastDone }));
  const percent = nodes.length ? Math.round(((lastDone + 1) / nodes.length) * 100) : 0;
  return { percent, nodes };
}

// 从 PR URL 提取编号:https://…/pull/15 → "#15";取不到回退 "PR"。
function prNumber(url: string): string {
  const m = url.match(/\/pull\/(\d+)/) ?? url.match(/(\d+)\/?$/);
  return m ? `#${m[1]}` : "PR";
}

function finishLabel(status: string): string {
  if (status === "failed") return "失败时间";
  if (status === "cancelled") return "取消时间";
  return "完成时间";
}

// 多仓 PR 表：每行展示仓名 / 子状态 / base→target / PR。
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
                  <span className="t-title">
                    {r.role === "main"
                      ? "主仓"
                      : isPendingSubRepoPath(r.relative_path)
                        ? "子仓（待 worker 派生路径）"
                        : r.relative_path}
                  </span>
                  {r.role === "sub" && !isPendingSubRepoPath(r.relative_path) ? (
                    <span className="t-meta mono">{r.relative_path}</span>
                  ) : null}
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
