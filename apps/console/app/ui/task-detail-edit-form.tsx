"use client";

import type { Task } from "@claude-center/db";
import { Check } from "lucide-react";
import { FormEvent, useState } from "react";
import { useAsyncAction } from "../lib/use-async-action";
import { DateTimePicker, Select } from "./controls";

// 任务编辑表单：详情页 + 任务流列表的编辑弹窗共用（仅草稿/定时态可编辑）。
// 按「基本信息 / 分支配置 / 执行选项 / 调度」分区排版，与新建表单 ComposeTaskForm 保持一致。
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
      <section className="form-section">
        <h3 className="form-section-title">基本信息</h3>
        <div className="field">
          <label className="field-label">标题</label>
          <input name="title" defaultValue={task.title} required disabled={busy} />
        </div>
        <div className="field">
          <label className="field-label">目标</label>
          <textarea name="description" rows={4} defaultValue={task.description} required disabled={busy} />
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">分支配置</h3>
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
            <Select
              value={submitMode}
              onChange={(value) => setSubmitMode(value as "pr" | "push")}
              options={[
                { value: "pr", label: "创建 PR" },
                { value: "push", label: "直接提交推送" }
              ]}
              disabled={busy}
              ariaLabel="提交模式"
            />
          </div>
        </div>
      </section>

      <section className="form-section">
        <h3 className="form-section-title">执行选项</h3>
        <div className="form-row">
          {submitMode === "pr" ? (
            <div className="field">
              <label className="field-label">自动合并 PR</label>
              <Select
                value={autoMergePr ? "on" : "off"}
                onChange={(value) => setAutoMergePr(value === "on")}
                options={[
                  { value: "off", label: "否 · 仅创建 PR" },
                  { value: "on", label: "是 · 创建后自动合并" }
                ]}
                disabled={busy}
                ariaLabel="自动合并 PR"
              />
            </div>
          ) : (
            <div className="field" aria-hidden />
          )}
          <div className="field">
            <label className="field-label">执行模型</label>
            <Select
              value={model}
              onChange={(value) => setModel(value as typeof model)}
              options={[
                { value: "default", label: "默认 · 跟随 Worker" },
                { value: "opus", label: "Opus" },
                { value: "sonnet", label: "Sonnet" },
                { value: "haiku", label: "Haiku" }
              ]}
              disabled={busy}
              ariaLabel="执行模型"
            />
          </div>
        </div>
        <div className="field">
          <label className="field-label">自动回复（兜底）</label>
          <Select
            value={autoReply ? "on" : "off"}
            onChange={(value) => setAutoReply(value === "on")}
            options={[
              { value: "off", label: "否 · 等人回复（默认）" },
              { value: "on", label: "是 · 无人值守，按规则兜底" }
            ]}
            disabled={busy}
            ariaLabel="自动回复"
          />
        </div>
        {autoReply ? (
          <div className="field">
            <label className="field-label">
              决策预案 <span className="field-hint">可选；auto_reply=true 时拼入 prompt</span>
            </label>
            <textarea
              rows={2}
              value={autoDecisionHints}
              onChange={(e) => setAutoDecisionHints(e.target.value)}
              placeholder="prefer minimal change; keep existing patterns; ..."
              disabled={busy}
            />
          </div>
        ) : null}
      </section>

      <section className="form-section">
        <h3 className="form-section-title">调度</h3>
        <div className="field">
          <label className="field-label">
            定时发布 <span className="field-hint">留空则为草稿</span>
          </label>
          <DateTimePicker
            name="scheduledAt"
            defaultValue={scheduledAtDefault}
            minNow
            disabled={busy}
            placeholder="留空为草稿；选择时间则定时发布"
          />
        </div>
      </section>

      {error ? <div className="error-box">{error}</div> : null}
      <div className="form-actions">
        <button className="btn btn-sm" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          <Check size={14} />
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
