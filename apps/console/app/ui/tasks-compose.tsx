"use client";

import type { Project, Task } from "@claude-center/db";
import { Send } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { metaOf } from "./shared";
import { Drawer, Select } from "./controls";

// 发布任务表单 + 其抽屉容器。从任务流列表抽出（仅创建任务用；详情已迁 /tasks/[id]）。
function ComposeTaskForm({
  projects,
  candidateTasks,
  busy,
  submitError,
  selectedProjectId,
  onSelectProject,
  onSubmit
}: {
  projects: Project[];
  candidateTasks: Task[];
  busy: boolean;
  submitError: string | null;
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [branchState, setBranchState] = useState<"idle" | "loading" | "error">("idle");
  const [submitMode, setSubmitMode] = useState<"pr" | "push">("pr");
  const [autoMergePr, setAutoMergePr] = useState(false);
  const [autoReply, setAutoReply] = useState(false);
  const [model, setModel] = useState<"default" | "opus" | "sonnet" | "haiku">("default");

  useEffect(() => {
    if (!selectedProjectId) {
      setBranches([]);
      setBranchState("idle");
      return;
    }
    let active = true;
    setBranchState("loading");
    fetch(`/api/projects/${selectedProjectId}/branches`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { branches: string[] };
        if (active) {
          setBranches(data.branches);
          setBranchState("idle");
        }
      })
      .catch(() => {
        if (active) {
          setBranches([]);
          setBranchState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [selectedProjectId]);

  const branchHint =
    branchState === "loading"
      ? "拉取分支中…"
      : branchState === "error"
        ? "拉取失败，可手填"
        : branches.length > 0
          ? `${branches.length} 个远程分支`
          : "可手动输入";

  // 前置任务候选：同项目、未取消（取消的任务无法被验收，选它会导致后置永久阻塞）。
  const dependencyCandidates = candidateTasks.filter(
    (task) => task.project_id === selectedProjectId && task.status !== "cancelled"
  );

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label">项目</label>
        <Select
          value={selectedProjectId}
          onChange={onSelectProject}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          placeholder="选择项目"
          ariaLabel="项目"
        />
      </div>
      <div className="field">
        <label className="field-label">标题</label>
        <input name="title" placeholder="修复登录按钮状态" required />
      </div>
      <div className="field">
        <label className="field-label">目标</label>
        <textarea
          name="description"
          rows={4}
          placeholder="写清期望行为、约束和验收方式"
          required
        />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">
            签出分支 <span className="field-hint">{branchHint}</span>
          </label>
          <input name="baseBranch" list="cc-branch-list" defaultValue="main" placeholder="main" />
        </div>
        <div className="field">
          <label className="field-label">
            PR 目标分支 <span className="field-hint">留空同签出分支</span>
          </label>
          <input name="targetBranch" list="cc-branch-list" placeholder="main" />
        </div>
      </div>
      <datalist id="cc-branch-list">
        {branches.map((branch) => (
          <option key={branch} value={branch} />
        ))}
      </datalist>
      <div className="form-row">
        <div className="field">
          <label className="field-label">
            工作分支 <span className="field-hint">留空自动生成</span>
          </label>
          <input name="workBranch" placeholder="cc/..." />
        </div>
        <div className="field">
          <label className="field-label">提交模式</label>
          <Select
            name="submitMode"
            value={submitMode}
            onChange={(value) => setSubmitMode(value as "pr" | "push")}
            options={[
              { value: "pr", label: "创建 PR" },
              { value: "push", label: "直接提交推送" }
            ]}
            ariaLabel="提交模式"
          />
        </div>
      </div>
      {submitMode === "pr" ? (
        <div className="field">
          <label className="field-label">
            自动合并 PR <span className="field-hint">PR 创建后由 Worker 自动 gh pr merge --merge</span>
          </label>
          <Select
            name="autoMergePr"
            value={autoMergePr ? "on" : "off"}
            onChange={(value) => setAutoMergePr(value === "on")}
            options={[
              { value: "off", label: "否 · 仅创建 PR" },
              { value: "on", label: "是 · 创建后自动合并" }
            ]}
            ariaLabel="自动合并 PR"
          />
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">
          自动回复（兜底） <span className="field-hint">主防线让 Claude 不要停下问；真停了：零改动→失败，有改动→自动续接最多 2 轮</span>
        </label>
        <Select
          name="autoReply"
          value={autoReply ? "on" : "off"}
          onChange={(value) => setAutoReply(value === "on")}
          options={[
            { value: "off", label: "否 · 等人回复（默认）" },
            { value: "on", label: "是 · 无人值守，按规则兜底" }
          ]}
          ariaLabel="自动回复"
        />
      </div>
      {autoReply ? (
        <div className="field">
          <label className="field-label">
            决策预案 <span className="field-hint">可选，喂给 Claude 当决策偏好（如"优先最小改动，跳过测试"）</span>
          </label>
          <textarea name="autoDecisionHints" rows={2} placeholder="prefer minimal change; keep existing patterns; ..." />
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">
          执行模型 <span className="field-hint">该任务执行时用哪个 Claude 模型，默认跟随 Worker</span>
        </label>
        <Select
          name="model"
          value={model}
          onChange={(value) => setModel(value as "default" | "opus" | "sonnet" | "haiku")}
          options={[
            { value: "default", label: "默认 · 跟随 Worker" },
            { value: "opus", label: "Opus" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" }
          ]}
          ariaLabel="执行模型"
        />
      </div>
      <div className="field">
        <label className="field-label">
          定时发布 <span className="field-hint">留空即建为草稿手动发布；设定时间则到点自动进入待处理队列</span>
        </label>
        <input name="scheduledAt" type="datetime-local" />
      </div>
      <div className="field">
        <label className="field-label">
          前置任务 <span className="field-hint">同项目，可多选；前置全部「已验收 / 已合并」后才会被领取</span>
        </label>
        {dependencyCandidates.length === 0 ? (
          <span className="field-hint">该项目暂无可作为前置的任务</span>
        ) : (
          <select name="dependsOn" multiple size={Math.min(6, Math.max(3, dependencyCandidates.length))}>
            {dependencyCandidates.map((task) => (
              <option key={task.id} value={task.id}>
                [{metaOf(task.status).label}] {task.title}
              </option>
            ))}
          </select>
        )}
      </div>
      {submitError ? <div className="error-box">{submitError}</div> : null}
      <button className="btn btn-primary" disabled={busy || projects.length === 0} type="submit">
        <Send size={16} />
        入队
      </button>
    </form>
  );
}

export function TaskDrawer({
  open,
  busy,
  submitError,
  projects,
  candidateTasks,
  selectedProjectId,
  onClose,
  onSelectProject,
  onSubmitTask,
  canCreateTask
}: {
  open: boolean;
  busy: boolean;
  submitError: string | null;
  projects: Project[];
  candidateTasks: Task[];
  selectedProjectId: string;
  onClose: () => void;
  onSelectProject: (id: string) => void;
  onSubmitTask: (event: FormEvent<HTMLFormElement>) => void;
  canCreateTask: boolean;
}) {
  // 仅用于「发布任务」表单；任务详情已迁至独立路由页 /tasks/[id]。
  return (
    <Drawer open={open} title={canCreateTask ? "发布任务" : ""} onClose={onClose}>
      {canCreateTask ? (
        <ComposeTaskForm
          projects={projects}
          candidateTasks={candidateTasks}
          busy={busy}
          submitError={submitError}
          selectedProjectId={selectedProjectId}
          onSelectProject={onSelectProject}
          onSubmit={onSubmitTask}
        />
      ) : null}
    </Drawer>
  );
}
