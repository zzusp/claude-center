"use client";

import type { Task } from "@claude-center/db";
import { Check } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAsyncAction } from "../lib/use-async-action";

// 任务编辑表单：详情页抽屉 + 任务流列表抽屉共用（仅草稿/定时态可编辑）。
export function TaskEditForm({
  task,
  onSaved,
  onCancel
}: {
  task: Task;
  onSaved: (updated: Task) => void;
  onCancel: () => void;
}) {
  const { busy, error, run } = useAsyncAction();
  const [submitMode, setSubmitMode] = useState<"pr" | "push">(task.submit_mode);
  const [autoMergePr, setAutoMergePr] = useState(task.auto_merge_pr);
  const [autoReply, setAutoReply] = useState(task.auto_reply);
  const [autoDecisionHints, setAutoDecisionHints] = useState(task.auto_decision_hints);
  const [model, setModel] = useState(task.model);

  // datetime-local 值格式：去掉秒+时区（只保留 "YYYY-MM-DDTHH:MM"）
  const scheduledAtDefault = task.scheduled_at
    ? task.scheduled_at.slice(0, 16)
    : "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scheduledAtRaw = (data.get("scheduledAt") as string) || "";
    await run(async () => {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          title: data.get("title") as string,
          description: data.get("description") as string,
          baseBranch: data.get("baseBranch") as string,
          workBranch: data.get("workBranch") as string,
          targetBranch: data.get("targetBranch") as string,
          submitMode,
          autoMergePr,
          autoReply,
          autoDecisionHints,
          model,
          scheduledAt: scheduledAtRaw ? new Date(scheduledAtRaw).toISOString() : null
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败：${response.status}`);
      }
      const payload = (await response.json()) as { task: Task };
      onSaved(payload.task);
    });
  }

  return (
    <form className="form" onSubmit={handleSubmit} style={{ width: "100%" }}>
      <div className="field">
        <label className="field-label">标题</label>
        <input name="title" defaultValue={task.title} required disabled={busy} />
      </div>
      <div className="field">
        <label className="field-label">目标</label>
        <textarea name="description" rows={4} defaultValue={task.description} required disabled={busy} />
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">签出分支</label>
          <input name="baseBranch" defaultValue={task.base_branch} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label">PR 目标分支</label>
          <input name="targetBranch" defaultValue={task.target_branch} disabled={busy} />
        </div>
      </div>
      <div className="form-row">
        <div className="field">
          <label className="field-label">工作分支</label>
          <input name="workBranch" defaultValue={task.work_branch} disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label">提交模式</label>
          <select value={submitMode} onChange={(e) => setSubmitMode(e.target.value as "pr" | "push")} disabled={busy}>
            <option value="pr">创建 PR</option>
            <option value="push">直接提交推送</option>
          </select>
        </div>
      </div>
      {submitMode === "pr" ? (
        <div className="field">
          <label className="field-label">自动合并 PR</label>
          <select value={autoMergePr ? "on" : "off"} onChange={(e) => setAutoMergePr(e.target.value === "on")} disabled={busy}>
            <option value="off">否 · 仅创建 PR</option>
            <option value="on">是 · 创建后自动合并</option>
          </select>
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">自动回复（兜底）</label>
        <select value={autoReply ? "on" : "off"} onChange={(e) => setAutoReply(e.target.value === "on")} disabled={busy}>
          <option value="off">否 · 等人回复（默认）</option>
          <option value="on">是 · 无人值守，按规则兜底</option>
        </select>
      </div>
      {autoReply ? (
        <div className="field">
          <label className="field-label">决策预案 <span className="field-hint">可选；auto_reply=true 时拼入 prompt</span></label>
          <textarea
            rows={2}
            value={autoDecisionHints}
            onChange={(e) => setAutoDecisionHints(e.target.value)}
            placeholder="prefer minimal change; keep existing patterns; ..."
            disabled={busy}
          />
        </div>
      ) : null}
      <div className="field">
        <label className="field-label">执行模型</label>
        <select value={model} onChange={(e) => setModel(e.target.value as typeof model)} disabled={busy}>
          <option value="default">默认 · 跟随 Worker</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label">
          定时发布 <span className="field-hint">留空则为草稿</span>
        </label>
        <input name="scheduledAt" type="datetime-local" defaultValue={scheduledAtDefault} disabled={busy} />
      </div>
      {error ? <div className="error-box">{error}</div> : null}
      <div className="review-btns">
        <button className="btn btn-sm" type="button" onClick={onCancel} disabled={busy}>取消</button>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          <Check size={14} />
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
