"use client";

import type { Worker, WorkerProjectLinkView } from "@claude-center/db";
import {
  Bot,
  Check,
  ChevronLeft,
  Clock,
  Cpu,
  FolderGit2,
  Hash,
  Info,
  ListTodo,
  MessageSquare,
  Network,
  Pencil,
  Power,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { KvRow, StatusBadge, StatusDot, fmtDateTime, postJson } from "./shared";
import { fmtAgo } from "./dashboard-shared";
import { isPlanSubscription, subscriptionLabel, UsageBlock, WorkingStateBadge } from "./worker-shared";
import { WorkerCommandPanel } from "./worker-command";
import { WorkerConversationsTab, WorkerTasksTab } from "./worker-detail-tabs";
import { usePolling } from "../lib/use-polling";

// 通用区块卡（命令日志 tab 用）。
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

// 概览卡：统一卡头 + 卡体，复用任务详情概览的 .ov-card 样式（scroll=true 时卡体撑满并内部滚动）。
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

type WorkerTabKey = "overview" | "tasks" | "conversations" | "commands";

const WORKER_TABS: { key: WorkerTabKey; label: string; icon: ReactNode; adminOnly?: boolean }[] = [
  { key: "overview", label: "概览", icon: <Info size={14} /> },
  { key: "tasks", label: "任务", icon: <ListTodo size={14} /> },
  { key: "conversations", label: "对话", icon: <MessageSquare size={14} /> },
  { key: "commands", label: "命令日志", icon: <Terminal size={14} />, adminOnly: true }
];

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
  const [activeTab, setActiveTab] = useState<WorkerTabKey>("overview");

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
    fetch(`/api/workers/${workerId}/projects`, { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { links?: WorkerProjectLinkView[] }) => setProjects(data.links ?? []))
      .catch(() => setProjects([]))
      .finally(() => setLoadingProjects(false));
  }, [workerId]);

  const tabs = WORKER_TABS.filter((tab) => !tab.adminOnly || canCommand);
  const online = worker.status === "online";

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
          <div className="detail-head-title">
            <h1 className="detail-page-title">{displayName(worker)}</h1>
            <StatusDot status={worker.status} pulse={online} />
            <StatusBadge status={worker.status} />
            {online ? <WorkingStateBadge state={worker.working_state} /> : null}
          </div>
        </div>
        <div className="detail-summary-bar">
          <div className="ds-item">
            <Network size={13} className="ico" />
            <span className="ds-k">主机</span>
            <span className="ds-v mono">{worker.host_name}</span>
          </div>
          <div className="ds-item">
            <Bot size={13} className="ico" />
            <span className="ds-k">Claude</span>
            <span className="ds-v">{worker.claude_version ?? "—"}</span>
          </div>
          <div className="ds-item">
            <Clock size={13} className="ico" />
            <span className="ds-k">心跳</span>
            <span className="ds-v">{fmtAgo(worker.last_seen_at)}</span>
          </div>
          <div className="ds-item">
            <Cpu size={13} className="ico" />
            <span className="ds-k">在途</span>
            <span className="ds-v">{worker.active_task_count ?? 0}/{worker.max_parallel}</span>
          </div>
          <div className="ds-item">
            <Check size={13} className="ico" />
            <span className="ds-k">完成</span>
            <span className="ds-v">{worker.completed_task_count ?? 0}</span>
          </div>
          <div className="ds-item">
            <Hash size={13} className="ico" />
            <span className="ds-k">ID</span>
            <span className="ds-v mono">{worker.id}</span>
          </div>
        </div>
        <nav className="detail-tabs">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.key}
              className={`detail-tab-btn${activeTab === tab.key ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className="dt-ico">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      <div className={`detail-tab-content${activeTab === "overview" ? " detail-tab-content--wide" : ""}`}>
        {activeTab === "overview" ? (
          <div className="overview-grid">
            <div className="ov-left">
              <OvCard icon={<Info size={15} />} title="基本信息">
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
                          <button type="button" className="btn btn-sm" disabled={renameSaving} onClick={saveRename}>
                            保存
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => setRenaming(false)}>
                            取消
                          </button>
                        </span>
                      ) : (
                        <span className="rename-row">
                          <span>{displayName(worker)}</span>
                          {canCommand ? (
                            <>
                              <button type="button" className="btn-icon" title="重命名" onClick={startRename}>
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
                  <KvRow k="Worker ID" v={worker.id} mono />
                  <KvRow k="Claude Code 版本" v={worker.claude_version ?? "—"} mono />
                  <KvRow k="订阅类型" v={subscriptionLabel(worker.subscription_type)} />
                </div>
                {isPlanSubscription(worker.subscription_type) ? (
                  <div className="ov-usage-section">
                    {worker.usage.five_hour || worker.usage.seven_day ? (
                      <div className="usage-grid">
                        {worker.usage.five_hour ? <UsageBlock label="5 小时窗口" win={worker.usage.five_hour} /> : null}
                        {worker.usage.seven_day ? <UsageBlock label="7 天窗口" win={worker.usage.seven_day} /> : null}
                      </div>
                    ) : (
                      <div className="remote-hint">用量采集失败：{worker.usage.error ?? "Worker 暂未上报用量"}</div>
                    )}
                  </div>
                ) : null}
              </OvCard>

              <OvCard icon={<Terminal size={15} />} title="运行配置">
                <div className="kv">
                  <KvRow k="并行上限" v={String(worker.max_parallel)} />
                  <KvRow
                    k="运行终端"
                    v={worker.terminal_command || "（未配置，使用系统默认）"}
                    mono={!!worker.terminal_command}
                  />
                  {worker.claude_pre_command ? <KvRow k="前置命令" v={worker.claude_pre_command} mono /> : null}
                  <KvRow k="创建于" v={fmtDateTime(worker.created_at)} />
                  <KvRow k="更新于" v={fmtDateTime(worker.updated_at)} />
                  {Object.keys(worker.capabilities).length > 0 ? (
                    <div className="kv-row">
                      <span className="kv-k">能力</span>
                      <div className="cap-tags">
                        {Object.entries(worker.capabilities).map(([k, v]) => (
                          <span key={k} className="cap-tag">
                            {v === true ? k : `${k}: ${String(v)}`}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {Object.keys(worker.metadata).length > 0 ? (
                    <KvRow k="元数据" v={JSON.stringify(worker.metadata)} mono />
                  ) : null}
                </div>
              </OvCard>

              <OvCard icon={<Power size={15} />} title="工作状态">
                <div className="kv">
                  <KvRow k="在线状态" v={<StatusBadge status={worker.status} />} />
                  <KvRow
                    k="工作状态"
                    v={
                      <span className="remote-toggle-row">
                        {online ? (
                          <WorkingStateBadge state={worker.working_state} />
                        ) : (
                          <span className="remote-hint">离线</span>
                        )}
                        {canCommand ? (
                          worker.allow_remote_control ? (
                            <button type="button" className="btn btn-sm" disabled={toggling} onClick={toggleWorking}>
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
                  <KvRow k="远程开关" v={worker.allow_remote_control ? "已开启" : "未开启"} />
                  <KvRow k="最后心跳" v={`${fmtDateTime(worker.last_seen_at)}（${fmtAgo(worker.last_seen_at)}）`} />
                </div>
              </OvCard>

              <OvCard icon={<Cpu size={15} />} title="任务统计">
                <div className="kv">
                  <KvRow k="在途任务" v={`${worker.active_task_count ?? 0} / ${worker.max_parallel}`} />
                  <KvRow k="累计完成" v={String(worker.completed_task_count ?? 0)} />
                  <KvRow k="并行上限" v={String(worker.max_parallel)} />
                </div>
                <div className="ov-card-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setActiveTab("tasks")}>
                    <ListTodo size={14} />
                    查看全部任务
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setActiveTab("conversations")}>
                    <MessageSquare size={14} />
                    查看对话
                  </button>
                </div>
              </OvCard>
            </div>

            <OvCard
              className="ov-card--desc"
              icon={<FolderGit2 size={15} />}
              title={`关联项目（${projects.length}）`}
              scroll
            >
              {loadingProjects ? (
                <div className="remote-hint">加载中…</div>
              ) : projects.length === 0 ? (
                <div className="remote-hint">暂无关联项目</div>
              ) : (
                <div className="project-links">
                  {projects.map((link) => (
                    <div className="project-link-row" key={`${link.project_id}-${link.local_path}`}>
                      <FolderGit2 size={15} className="ico" />
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
            </OvCard>

            {canCommand ? (
              <OvCard className="ov-card--full" icon={<Trash2 size={15} />} title="危险操作">
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <p style={{ margin: 0, fontSize: 13, color: "var(--text-3)" }}>
                    删除后 Worker 记录从数据库移除，已关联的任务历史保留。Worker 重新连接后会自动重注册。
                  </p>
                  {deleteError ? <p style={{ margin: 0, fontSize: 13, color: "var(--tone-failed)" }}>{deleteError}</p> : null}
                  <div>
                    <button type="button" className="btn btn-danger" disabled={deleting} onClick={handleDelete}>
                      <Trash2 size={13} />
                      {deleting ? "删除中…" : "删除此 Worker"}
                    </button>
                  </div>
                </div>
              </OvCard>
            ) : null}
          </div>
        ) : null}

        {activeTab === "tasks" ? <WorkerTasksTab workerId={workerId} /> : null}

        {activeTab === "conversations" ? <WorkerConversationsTab workerId={workerId} /> : null}

        {activeTab === "commands" && canCommand ? (
          <Section icon={<Terminal size={15} />} title="命令日志">
            <WorkerCommandPanel
              workerId={workerId}
              terminalCommand={worker.terminal_command}
              preCommand={worker.claude_pre_command}
            />
          </Section>
        ) : null}
      </div>
    </div>
  );
}
