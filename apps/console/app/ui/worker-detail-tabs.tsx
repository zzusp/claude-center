"use client";

import type { Conversation, Task } from "@claude-center/db";
import {
  ChevronLeft, ChevronRight, FolderGit2, GitBranch, GitPullRequest, Inbox, MessageSquare
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Empty, StatusBadge, computeTaskDurationMs, fmtDateTime, fmtDurationMs, metaOf, parsePrNumber
} from "./shared";
import { usePolling } from "../lib/use-polling";

// 任务状态快速筛选 chip：'' = 全部，其余复用 STATUS_META 的中文标签（metaOf）。
const TASK_STATUS_CHIPS = [
  "", "draft", "scheduled", "pending", "claimed", "running", "waiting",
  "success", "merged", "failed", "cancelled"
];

const TASKS_PAGE_SIZE = 50;

type TaskListResponse = { tasks: Task[]; total: number; page: number; pageSize: number };

// worker 详情「任务」tab：该 worker 名下任务，状态 chip 快速筛选 + 分页（后端 /api/tasks?workerId=&status=&page=）。
// 结构与任务调度页一致：card > toolbar(筛选) + card-body.flush(表格) + pager；仅列表、整行点击跳任务详情。
export function WorkerTasksTab({ workerId }: { workerId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<TaskListResponse>({ tasks: [], total: 0, page: 1, pageSize: TASKS_PAGE_SIZE });
  const [loading, setLoading] = useState(true);

  // 切换状态筛选回到第 1 页。
  useEffect(() => {
    setPage(1);
  }, [status]);

  usePolling(
    async (isActive) => {
      const params = new URLSearchParams();
      params.set("workerId", workerId);
      if (status) params.set("status", status);
      params.set("pageSize", String(TASKS_PAGE_SIZE));
      params.set("page", String(page));
      try {
        const res = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as TaskListResponse;
        if (isActive()) setData(json);
      } catch {
        /* 轮询失败静默 */
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [workerId, status, page]
  );

  const totalPages = Math.max(1, Math.ceil(data.total / TASKS_PAGE_SIZE));

  return (
    <section className="card">
      <div className="toolbar">
        <div className="chip-row">
          {TASK_STATUS_CHIPS.map((s) => (
            <button
              key={s || "all"}
              type="button"
              className={`btn btn-sm${status === s ? " btn-primary" : ""}`}
              onClick={() => setStatus(s)}
            >
              {s === "" ? "全部" : metaOf(s).label}
            </button>
          ))}
        </div>
      </div>

      <div className="card-body flush">
        {data.tasks.length === 0 ? (
          <Empty icon={<Inbox size={28} />} text={loading ? "加载中…" : "该 Worker 暂无任务"} />
        ) : (
          <div className="table-wrap scroll-rows-10">
            <table className="table table-static">
              <thead>
                <tr>
                  <th>任务</th>
                  <th>项目</th>
                  <th>分支</th>
                  <th>状态</th>
                  <th>PR</th>
                  <th>耗时</th>
                  <th>创建</th>
                </tr>
              </thead>
              <tbody>
                {data.tasks.map((task) => {
                  const prNumber = parsePrNumber(task.pr_url);
                  return (
                    <tr key={task.id} className="row-clickable" onClick={() => router.push(`/tasks/${task.id}`)}>
                      <td><span className="t-title">{task.title}</span></td>
                      <td className="t-meta">
                        <span className="cell-icon">
                          <FolderGit2 size={13} className="ico" />
                          {task.project_name ?? task.project_id}
                        </span>
                      </td>
                      <td className="mono">
                        <span className="cell-icon">
                          <GitBranch size={13} className="ico" />
                          {task.work_branch}
                        </span>
                      </td>
                      <td><StatusBadge status={task.status} /></td>
                      <td className="t-meta">
                        {task.pr_url ? (
                          <a
                            className="cell-icon"
                            href={task.pr_url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <GitPullRequest size={13} className="ico" />
                            {prNumber != null ? `#${prNumber}` : "PR"}
                          </a>
                        ) : (
                          <span className="cell-muted">—</span>
                        )}
                      </td>
                      <td className="t-num">{fmtDurationMs(computeTaskDurationMs(task))}</td>
                      <td className="t-num">{fmtDateTime(task.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.total > TASKS_PAGE_SIZE ? (
        <div className="pager">
          <span className="pager-info">
            第 {Math.min(page, totalPages)} / {totalPages} 页 · 共 {data.total} 条
          </span>
          <div className="pager-controls">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={16} />
              上一页
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              下一页
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// worker 详情「对话」tab：该 worker 名下对话，结构与任务调度页一致（card > card-body.flush 表格）。
// 仅列表、整行点击跳实时对话页并定位（/chat?c=<id>）。
export function WorkerConversationsTab({ workerId }: { workerId: string }) {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  usePolling(
    async (isActive) => {
      try {
        const res = await fetch(`/api/conversations?workerId=${workerId}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { conversations: Conversation[] };
        if (isActive()) setConversations(json.conversations);
      } catch {
        /* 轮询失败静默 */
      } finally {
        if (isActive()) setLoading(false);
      }
    },
    [workerId]
  );

  return (
    <section className="card">
      <div className="card-body flush">
        {conversations.length === 0 ? (
          <Empty icon={<MessageSquare size={28} />} text={loading ? "加载中…" : "该 Worker 暂无对话"} />
        ) : (
          <div className="table-wrap scroll-rows-10">
            <table className="table table-static">
              <thead>
                <tr>
                  <th>对话</th>
                  <th>项目</th>
                  <th>分支</th>
                  <th>状态</th>
                  <th>最近消息</th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((c) => (
                  <tr key={c.id} className="row-clickable" onClick={() => router.push(`/chat?c=${c.id}`)}>
                    <td><span className="t-title">{c.title || "未命名对话"}</span></td>
                    <td className="t-meta">
                      <span className="cell-icon">
                        <FolderGit2 size={13} className="ico" />
                        {c.project_name ?? c.project_id}
                      </span>
                    </td>
                    <td className="mono">
                      <span className="cell-icon">
                        <GitBranch size={13} className="ico" />
                        {c.branch}
                      </span>
                    </td>
                    <td>
                      <span className="badge" data-tone={c.status === "active" ? "running" : "cancelled"}>
                        {c.generating ? "回复中" : c.status === "active" ? "进行中" : "已关闭"}
                      </span>
                    </td>
                    <td className="t-num">{fmtDateTime(c.last_message_at ?? c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
