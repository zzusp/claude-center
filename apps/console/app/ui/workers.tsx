"use client";

import type {
  DirectCommand,
  Permission,
  Project,
  Role,
  SortDir,
  Task,
  TaskComment,
  TaskEvent,
  UserWithProjects,
  Worker,
  WorkerProjectLinkView
} from "@claude-center/db";
import {
  Activity, ArrowDown, ArrowUp, Boxes, Bot, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert,
  Clock, Cpu, Database, ExternalLink, FolderGit2, GitBranch, Inbox, LayoutGrid, ListTodo, LogOut,
  MessageSquare, Network, Pencil, Plus, Power, RadioTower, RotateCcw, Save, Search, Send, Server,
  ShieldCheck, Tag, Trash2, UserRound, Users, X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Empty, KvRow, MergeStatusBadge, StatusBadge, StatusDot,
  fmtDateTime, fmtTime, metaOf, postJson
} from "./shared";
import {
  ROLE_LABEL, ROLE_OPTIONS, SPARK_CAP, emptyOverview, fmtAgo, syncAgo,
  type CurrentUser, type Health, type ViewKey
} from "./dashboard-shared";
import { POLL_INTERVAL_MS, usePolling } from "../lib/use-polling";
import { Drawer, Select } from "./controls";
import { WorkingStateBadge } from "./worker-shared";


function WorkersView({
  workers,
  canCommand,
  onDeleted
}: {
  workers: Worker[];
  canCommand: boolean;
  onDeleted: (id: string) => void;
}) {
  const router = useRouter();
  const onlineWorkers = workers.filter((worker) => worker.status === "online").length;

  function displayName(worker: Worker): string {
    return worker.label || worker.name;
  }

  // 卡片本身可点击跳详情，删除按钮需阻止冒泡；二次确认后调后端 DELETE，成功后乐观移除。
  async function handleDelete(event: MouseEvent, worker: Worker) {
    event.stopPropagation();
    if (!window.confirm(`确认删除 Worker「${displayName(worker)}」？此操作不可撤销，关联的任务事件历史会保留（仅置空 worker 引用）。`)) {
      return;
    }
    try {
      const res = await fetch(`/api/workers/${worker.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "删除失败");
      }
      onDeleted(worker.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-title-wrap">
          <h1 className="page-head-title">执行机群</h1>
          <span className="page-head-sub">
            {onlineWorkers}/{workers.length} 在线 · 心跳 60s 超时判离线 · 在线≠接任务
          </span>
        </div>
      </div>

      {workers.length === 0 ? (
        <section className="card">
          <Empty icon={<Server size={28} />} text="暂无 Worker 心跳" />
        </section>
      ) : (
        <div className="worker-grid">
          {workers.map((worker) => {
            return (
              <article
                className="worker-card"
                key={worker.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/workers/${worker.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    router.push(`/workers/${worker.id}`);
                  }
                }}
              >
                <div className="worker-top">
                  <StatusDot status={worker.status} pulse={worker.status === "online"} />
                  <span className="worker-name">{displayName(worker)}</span>
                  <StatusBadge status={worker.status} />
                  <WorkingStateBadge state={worker.working_state} />
                  {canCommand && (
                    <button
                      type="button"
                      className="btn-icon"
                      title="删除 Worker"
                      style={{ marginLeft: "auto", color: "var(--failed)" }}
                      onClick={(event) => handleDelete(event, worker)}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <div className="worker-rows">
                  <div className="worker-row">
                    <Network size={13} className="ico" />
                    <span className="v">{worker.host_name}</span>
                  </div>
                  <div className="worker-row">
                    <Bot size={13} className="ico" />
                    <span className="v mono">claude {worker.claude_version ?? "—"}</span>
                  </div>
                  <div className="worker-row">
                    <Clock size={13} className="ico" />
                    <span className="v">心跳 {fmtAgo(worker.last_seen_at)}</span>
                  </div>
                  <div className="worker-row">
                    <Activity size={13} className="ico" />
                    <span className="v">
                      在途 {worker.active_task_count ?? 0}/{worker.max_parallel}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

    </>
  );
}


export { WorkersView };
