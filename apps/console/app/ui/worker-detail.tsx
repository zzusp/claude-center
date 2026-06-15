"use client";

import type { Worker, WorkerProjectLinkView } from "@claude-center/db";
import {
  Activity,
  Bot,
  ChevronLeft,
  Clock,
  Cpu,
  FolderGit2,
  Info,
  Network,
  Pencil,
  Power,
  Server,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { KvRow, StatusBadge, StatusDot, fmtDateTime, postJson, type Tone } from "./shared";
import { TONE_COLOR, fmtAgo } from "./dashboard-shared";
import { usePolling } from "../lib/use-polling";

const SUBSCRIPTION_LABEL: Record<string, string> = {
  max: "套餐订阅 · Max",
  pro: "套餐订阅 · Pro",
  team: "套餐订阅 · Team",
  enterprise: "套餐订阅 · Enterprise",
  api: "API 计费",
  unknown: "未识别"
};

function subscriptionLabel(type: string): string {
  return SUBSCRIPTION_LABEL[type] ?? type;
}

function isPlanSubscription(type: string): boolean {
  return type !== "api" && type !== "unknown";
}

function fmtResetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "已重置";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function UsageBlock({ label, win }: { label: string; win: { utilization: number; resets_at: string } }) {
  const pct = Math.max(0, Math.min(100, win.utilization));
  const tone: Tone = pct >= 90 ? "failed" : pct >= 70 ? "pending" : "success";
  return (
    <div className="usage-block">
      <div className="usage-head">
        <span>{label}</span>
        <span className="pct">
          已用 {pct.toFixed(0)}% · 重置剩余 {fmtResetIn(win.resets_at)}
        </span>
      </div>
      <div className="usage-track">
        <div className="usage-fill" style={{ width: `${pct}%`, background: TONE_COLOR[tone] }} />
      </div>
    </div>
  );
}

function WorkingStateBadge({ state }: { state: string }) {
  const working = state === "working";
  return (
    <span className="badge" data-tone={working ? "success" : "pending"}>
      <span className="glyph">{working ? "▶" : "⏸"}</span>
      {working ? "工作中" : "空闲"}
    </span>
  );
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card detail-section">
      <div className="section-head">
        <span className="section-ico">{icon}</span>
        <h3 className="section-title">{title}</h3>
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

export default function WorkerDetailPage({
  initialWorker,
  canCommand
}: {
  initialWorker: Worker;
  canCommand: boolean;
}) {
  const router = useRouter();
  const workerId = initialWorker.id;
  const [worker, setWorker] = useState<Worker>(initialWorker);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState("");

  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState("");

  const [projects, setProjects] = useState<WorkerProjectLinkView[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  usePolling(
    async (isActive) => {
      try {
        const res = await fetch(`/api/workers/${workerId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { worker: Worker };
        if (isActive()) setWorker(data.worker);
      } catch {
        /* 轮询失败静默 */
      }
    },
    [workerId]
  );

  useEffect(() => {
    fetch(`/api/workers/${workerId}/projects`)
      .then((res) => res.json())
      .then((data: { links?: WorkerProjectLinkView[] }) => setProjects(data.links ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false));
  }, [workerId]);

  function displayName(w: Worker): string {
    return w.label || w.name;
  }

  function handleBack() {
    if (window.history.length > 1) {
      router.back();
    } else {
      router.push("/workers");
    }
  }

  function startRename() {
    setRenameValue(worker.label ?? "");
    setRenameError("");
    setRenaming(true);
  }

  async function saveRename() {
    setRenameSaving(true);
    setRenameError("");
    try {
      await postJson(`/api/workers/${workerId}`, { label: renameValue });
      const res = await fetch(`/api/workers/${workerId}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { worker: Worker };
        setWorker(data.worker);
      }
      setRenaming(false);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "重命名失败");
    } finally {
      setRenameSaving(false);
    }
  }

  async function clearLabel() {
    try {
      await postJson(`/api/workers/${workerId}`, { label: "" });
      const res = await fetch(`/api/workers/${workerId}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { worker: Worker };
        setWorker(data.worker);
      }
    } catch {
      /* ignore */
    }
  }

  async function toggleWorking() {
    const next = worker.working_state === "working" ? "idle" : "working";
    setToggling(true);
    setToggleError("");
    try {
      await postJson(`/api/workers/${workerId}/working-state`, { state: next });
      const res = await fetch(`/api/workers/${workerId}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { worker: Worker };
        setWorker(data.worker);
      }
    } catch (error) {
      setToggleError(error instanceof Error ? error.message : "切换失败");
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`确认删除 Worker「${displayName(worker)}」？此操作不可撤销。`)) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/workers/${workerId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/workers");
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteError(data.error ?? "删除失败");
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="detail-page">
      <header className="detail-page-top">
        <button type="button" className="detail-back" onClick={handleBack}>
          <ChevronLeft size={16} />
          返回执行机群
        </button>
        <div className="detail-page-head">
          <h1 className="detail-page-title">{displayName(worker)}</h1>
          <div className="detail-tags">
            <StatusDot status={worker.status} pulse={worker.status === "online"} />
            <StatusBadge status={worker.status} />
            <WorkingStateBadge state={worker.working_state} />
            <span className="tag">
              <Bot size={13} className="ico" />
              claude {worker.claude_version ?? "—"}
            </span>
            <span className="tag">
              <Network size={13} className="ico" />
              {worker.host_name}
            </span>
          </div>
        </div>
      </header>

      <div className="detail-page-body">
        <Section icon={<Info size={15} />} title="基本信息">
          <div className="kv">
            <KvRow
              k="显示名"
              v={
                renaming ? (
                  <span className="rename-row">
                    <input
                      className="rename-input"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename();
                        if (e.key === "Escape") setRenaming(false);
                      }}
                      placeholder={worker.name}
                      autoFocus
                    />
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={renameSaving}
                      onClick={saveRename}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setRenaming(false)}
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <span className="rename-row">
                    <span>{displayName(worker)}</span>
                    {canCommand ? (
                      <>
                        <button
                          type="button"
                          className="btn-icon"
                          title="重命名"
                          onClick={startRename}
                        >
                          <Pencil size={13} />
                        </button>
                        {worker.label ? (
                          <button
                            type="button"
                            className="btn-icon"
                            title="清除自定义名，恢复机器名"
                            onClick={clearLabel}
                          >
                            <X size={13} />
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </span>
                )
              }
            />
            {renameError ? <KvRow k="" v={<span className="remote-hint">{renameError}</span>} /> : null}
            <KvRow k="机器名" v={worker.name} mono />
            <KvRow k="主机" v={worker.host_name} mono />
            <KvRow k="Worker 版本" v={`v${worker.app_version}`} mono />
            <KvRow k="Claude Code 版本" v={worker.claude_version ?? "—"} mono />
            <KvRow k="订阅类型" v={subscriptionLabel(worker.subscription_type)} />
            <KvRow k="Worker ID" v={worker.id} mono />
          </div>
        </Section>

        <Section icon={<Power size={15} />} title="工作状态">
          <div className="kv">
            <KvRow k="在线状态" v={<StatusBadge status={worker.status} />} />
            <KvRow
              k="工作状态"
              v={
                <span className="remote-toggle-row">
                  <WorkingStateBadge state={worker.working_state} />
                  {canCommand ? (
                    worker.allow_remote_control ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={toggling}
                        onClick={toggleWorking}
                      >
                        {worker.working_state === "working" ? "切到空闲" : "切到工作"}
                      </button>
                    ) : (
                      <span className="remote-hint">该 Worker 未开启远程开关</span>
                    )
                  ) : null}
                </span>
              }
            />
            {toggleError ? <KvRow k="" v={<span className="remote-hint">{toggleError}</span>} /> : null}
            <KvRow k="最后心跳" v={`${fmtDateTime(worker.last_seen_at)}（${fmtAgo(worker.last_seen_at)}）`} />
          </div>
        </Section>

        {isPlanSubscription(worker.subscription_type) ? (
          <Section icon={<Activity size={15} />} title="套餐用量">
            {worker.usage.five_hour || worker.usage.seven_day ? (
              <>
                {worker.usage.five_hour ? (
                  <UsageBlock label="5 小时窗口" win={worker.usage.five_hour} />
                ) : null}
                {worker.usage.seven_day ? (
                  <UsageBlock label="7 天窗口" win={worker.usage.seven_day} />
                ) : null}
              </>
            ) : (
              <div className="remote-hint">
                用量采集失败：{worker.usage.error ?? "Worker 暂未上报用量"}
              </div>
            )}
          </Section>
        ) : null}

        <Section
          icon={<Cpu size={15} />}
          title={`并行任务（${worker.active_task_count ?? 0}/${worker.max_parallel}）`}
        >
          {(worker.active_task_count ?? 0) === 0 ? (
            <div className="remote-hint">当前空闲，无在途任务</div>
          ) : (
            <div className="remote-hint">共 {worker.active_task_count} 个任务运行中</div>
          )}
        </Section>

        <Section icon={<FolderGit2 size={15} />} title="关联项目">
          {loadingProjects ? (
            <div className="remote-hint">加载中…</div>
          ) : projects.length === 0 ? (
            <div className="remote-hint">暂无关联项目</div>
          ) : (
            <div className="project-links">
              {projects.map((link) => (
                <div
                  className="project-link-row"
                  key={`${link.project_id}-${link.local_path}`}
                >
                  <FolderGit2 size={13} className="ico" />
                  <span className="project-link-name">{link.project_name}</span>
                  <span className="project-link-path mono">{link.local_path}</span>
                  {!link.enabled ? (
                    <span className="badge" data-tone="pending">
                      已停用
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section icon={<Terminal size={15} />} title="运行配置">
          <div className="kv">
            <KvRow k="并行上限" v={String(worker.max_parallel)} />
            <KvRow
              k="运行终端"
              v={worker.terminal_command || "（未配置，使用系统默认）"}
              mono={!!worker.terminal_command}
            />
            {worker.claude_pre_command ? (
              <KvRow k="前置命令" v={worker.claude_pre_command} mono />
            ) : null}
            <KvRow k="创建于" v={fmtDateTime(worker.created_at)} />
            <KvRow k="更新于" v={fmtDateTime(worker.updated_at)} />
            {Object.keys(worker.capabilities).length > 0 ? (
              <KvRow k="能力" v={JSON.stringify(worker.capabilities)} mono />
            ) : null}
            {Object.keys(worker.metadata).length > 0 ? (
              <KvRow k="元数据" v={JSON.stringify(worker.metadata)} mono />
            ) : null}
          </div>
        </Section>

        {canCommand ? (
          <Section icon={<Trash2 size={15} />} title="危险操作">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                删除后 Worker 记录从数据库移除，已关联的任务历史保留。Worker 重新连接后会自动重注册。
              </p>
              {deleteError ? <p style={{ margin: 0, fontSize: 13, color: "var(--tone-failed)" }}>{deleteError}</p> : null}
              <div>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={deleting}
                  onClick={handleDelete}
                >
                  <Trash2 size={13} />
                  {deleting ? "删除中…" : "删除此 Worker"}
                </button>
              </div>
            </div>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
