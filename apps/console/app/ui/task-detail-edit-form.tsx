"use client";

import type { AttachmentMeta, ProjectRepo, Task, TaskRepo } from "@claude-center/db";
import { Check, Send } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { useAsyncAction } from "../lib/use-async-action";
import { DateTimePicker, formatLocal, Select } from "./controls";
import { AttachmentUploader } from "./attachment-uploader";
import { DependencyPicker, SubRepoConfigSection, serializeTaskRepos, type SubStatesMap } from "./tasks-compose";

// 任务编辑表单：详情页 + 任务流列表的编辑弹窗共用（仅草稿/定时态可编辑，未发布前所有字段均可改）。
// 按「基本信息(含附件) / 分支配置 / 执行选项 / 调度 / 子仓配置」分区排版，字段位置 / 提示 / 可编辑项
// 与新建表单 ComposeTaskForm 逐项对齐——唯一差异是编辑不含「项目」选择（任务项目不可迁移）。
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
  const [dynamicWorkflow, setDynamicWorkflow] = useState(task.dynamic_workflow);
  // 附件编辑：预填来自任务已绑定附件（task.attachments，详情页已带；列表页 task 不含时由下方 effect 拉取）。
  // 上传新附件 / 移除已绑附件后，提交时把 attachments.map(a=>a.id) 作为 attachmentIds 整批下发，后端同步增删。
  const [attachments, setAttachments] = useState<AttachmentMeta[]>(task.attachments ?? []);
  // 远程分支候选：与新建表单一致，给签出 / PR 目标分支输入提供 datalist 自动补全（拉取失败可手填）。
  const [branches, setBranches] = useState<string[]>([]);
  // 前置任务编辑：候选任务（同项目）按需拉取；dependsOn 受控；depsReady 防止「未加载完就保存」误清空依赖。
  // depsReady=false 时提交不带 dependsOn 字段，后端按 undefined 保持原依赖不动。
  const [depCandidates, setDepCandidates] = useState<Task[]>([]);
  const [candidatesLoaded, setCandidatesLoaded] = useState(false);
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [depsReady, setDepsReady] = useState(false);
  // 多仓任务（spec docs/spec/task-multi-repo.md）：项目子仓清单 + 每子仓启用/分支受控状态，与新建表单共用 SubRepoConfigSection。
  // 预填来自任务现有 task_repos 快照：sub_status!=='skipped' 视为启用并沿用其分支，其余回退子仓默认分支。
  const [subRepos, setSubRepos] = useState<ProjectRepo[]>([]);
  const [subStates, setSubStates] = useState<SubStatesMap>({});
  // 提交意图：save 仅保存编辑（保留 draft/scheduled），publish 保存后立刻发布为 pending（待处理）。
  // 用 ref 而非 state，避免点击「保存并发布」后 setState 异步导致 handleSubmit 拿到旧值。
  const submitIntentRef = useRef<"save" | "publish">("save");

  // 把存库的 UTC 时刻（task.scheduled_at 是带 Z 的 ISO）转成「本地墙钟」"YYYY-MM-DDTHH:MM"
  // 喂给 DateTimePicker——它的值语义就是本地墙钟（formatLocal 的输出格式），保存时再 new Date(本地).toISOString()
  // 回到正确 UTC。曾经直接 slice(0,16) 取 UTC 墙钟当本地用，保存会把时刻按时区偏移整体提前（东八区 -8h），
  // 导致定时任务没到点就被提升认领（见 docs/spec/task-scheduled.md）。
  const scheduledAtDefault = task.scheduled_at ? formatLocal(new Date(task.scheduled_at)) : "";
  // 非 git 项目任务无分支（work_branch 为空占位）：隐藏分支配置 / 提交模式 / 自动合并。
  const isGit = Boolean(task.work_branch);

  // 拉前置任务候选（同项目）+ 当前依赖。当前依赖优先用 task.depends_on（详情页已带），
  // 列表页传入的 task 不含该字段时回退到单任务详情端点取。两者就绪后置 depsReady=true。
  useEffect(() => {
    let active = true;
    // 候选：同项目、排除自身、排除已取消（取消的前置永不达成、会永久阻塞本任务），
    // 并排除已完成 / 已合并（这两态已等同完成,加为前置只是干扰；与新建表单逻辑一致）。
    void fetch(`/api/tasks?projectId=${task.project_id}&pageSize=100`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tasks: Task[] }>) : null))
      .then((data) => {
        if (!active) return;
        if (data)
          setDepCandidates(
            data.tasks.filter(
              (t) =>
                t.id !== task.id &&
                t.status !== "cancelled" &&
                t.status !== "merged" &&
                t.status !== "success"
            )
          );
        setCandidatesLoaded(true);
      })
      .catch(() => {
        if (active) setCandidatesLoaded(true);
      });

    if (Array.isArray(task.depends_on)) {
      setDependsOn(task.depends_on);
      setDepsReady(true);
    } else {
      void fetch(`/api/tasks/${task.id}`, { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ task: Task }>) : null))
        .then((data) => {
          if (!active) return;
          setDependsOn(data?.task.depends_on ?? []);
          setDepsReady(true);
        })
        .catch(() => {
          if (active) setDepsReady(true);
        });
    }
    return () => {
      active = false;
    };
  }, [task.id, task.project_id, task.depends_on]);

  // 远程分支：与新建表单一致，给签出 / PR 目标分支输入提供 datalist 自动补全。非 git 任务无分支可拉。
  useEffect(() => {
    if (!isGit) {
      setBranches([]);
      return;
    }
    let active = true;
    fetch(`/api/projects/${task.project_id}/branches`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ branches: string[] }>) : Promise.reject(new Error())))
      .then((data) => {
        if (active) setBranches(data.branches);
      })
      .catch(() => {
        if (active) setBranches([]);
      });
    return () => {
      active = false;
    };
  }, [task.project_id, isGit]);

  // 拉项目子仓清单 + 任务现有 task_repos 快照（预填子仓启用/分支状态）+ 已绑定附件（列表页 task 不含 attachments 时回补）。
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/projects/${task.project_id}/repos`, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ repos: ProjectRepo[] }>) : Promise.reject(new Error())
      ),
      fetch(`/api/tasks/${task.id}`, { cache: "no-store" }).then((r) =>
        r.ok ? (r.json() as Promise<{ task: Task; taskRepos: TaskRepo[] }>) : Promise.reject(new Error())
      )
    ])
      .then(([repoData, taskData]) => {
        if (!active) return;
        // 已绑定附件以服务端最新快照为准（列表页传入的 task 不带 attachments 字段）。
        setAttachments(taskData.task?.attachments ?? []);
        const subs = repoData.repos.filter((r) => r.role === "sub");
        const snapshotByRepo = new Map((taskData.taskRepos ?? []).map((tr) => [tr.project_repo_id, tr]));
        setSubRepos(subs);
        setSubStates(
          Object.fromEntries(
            subs.map((s) => {
              const snap = snapshotByRepo.get(s.id);
              const enabled = snap ? snap.sub_status !== "skipped" : false;
              return [
                s.id,
                {
                  enabled,
                  baseBranch: enabled && snap ? snap.base_branch : s.default_branch,
                  workBranch: enabled && snap ? snap.work_branch : "",
                  targetBranch: enabled && snap ? snap.target_branch : s.default_branch
                }
              ];
            })
          )
        );
      })
      .catch(() => {
        if (active) {
          setSubRepos([]);
          setSubStates({});
        }
      });
    return () => {
      active = false;
    };
  }, [task.id, task.project_id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scheduledAtRaw = (data.get("scheduledAt") as string) || "";
    const intent = submitIntentRef.current;
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
          dynamicWorkflow,
          // 仅在依赖加载完成后才下发 dependsOn，避免「未加载完即保存」把原依赖清空（后端 undefined=保持不变）。
          dependsOn: depsReady ? dependsOn : undefined,
          // 多仓任务：仅当项目有子仓且清单已加载（subRepos 非空即已加载成功）才整批下发，
          // 否则不带该字段（后端 undefined=仅同步主仓行、保留原子仓配置），避免未加载就保存把子仓清空。
          taskRepos: subRepos.length > 0 ? serializeTaskRepos(subStates) : undefined,
          // 附件：整批下发期望全集（保留 + 新增），后端按差异增删。
          attachmentIds: attachments.map((a) => a.id),
          scheduledAt: scheduledAtRaw ? new Date(scheduledAtRaw).toISOString() : null
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败：${response.status}`);
      }
      const payload = (await response.json()) as { task: Task };
      // 保存成功后若为「保存并发布」意图，紧跟一次 publish 把状态翻成 pending（待处理）。
      // 复用详情页/列表页同一 publish action（draft/scheduled → pending）。
      if (intent === "publish") {
        const pubRes = await fetch(`/api/tasks/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "publish" })
        });
        if (!pubRes.ok) {
          const pubPayload = (await pubRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(pubPayload.error ?? `发布失败：${pubRes.status}`);
        }
        const pubJson = (await pubRes.json()) as { task: Task };
        onSaved(pubJson.task);
        return;
      }
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
          <label className="field-label">
            目标 <span className="field-hint">可粘贴 / 拖拽 / 选择图片或文件作为补充资料</span>
          </label>
          <textarea name="description" rows={6} defaultValue={task.description} required disabled={busy} />
          <AttachmentUploader attachments={attachments} onChange={setAttachments} disabled={busy} />
        </div>
      </section>

      {isGit ? (
        <section className="form-section">
          <h3 className="form-section-title">分支配置</h3>
          <div className="form-row">
            <div className="field">
              <label className="field-label">签出分支</label>
              <input name="baseBranch" list="cc-edit-branch-list" defaultValue={task.base_branch} disabled={busy} />
            </div>
            <div className="field">
              <label className="field-label">
                PR 目标分支 <span className="field-hint">留空同签出分支</span>
              </label>
              <input name="targetBranch" list="cc-edit-branch-list" defaultValue={task.target_branch} disabled={busy} />
            </div>
          </div>
          <datalist id="cc-edit-branch-list">
            {branches.map((branch) => (
              <option key={branch} value={branch} />
            ))}
          </datalist>
          <div className="form-row">
            <div className="field">
              <label className="field-label">
                工作分支 <span className="field-hint">留空自动生成</span>
              </label>
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
      ) : (
        <section className="form-section">
          <h3 className="form-section-title">非 Git 项目</h3>
          <div className="field">
            <span className="field-hint">该任务属于非 Git 项目：就地修改、无分支 / 提交模式 / PR。</span>
          </div>
        </section>
      )}

      <section className="form-section">
        <h3 className="form-section-title">执行选项</h3>
        <div className="form-row">
          {isGit && submitMode === "pr" ? (
            <div className="field">
              <label className="field-label">
                自动合并 PR <span className="field-hint">由 Worker 自动 gh pr merge --merge</span>
              </label>
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
            <label className="field-label">
              自动回复（兜底） <span className="field-hint">真停了：零改动→失败，有改动→续接 2 轮</span>
            </label>
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
        </div>
        <div className="form-row">
          <div className="field">
            <label className="field-label">
              执行模型 <span className="field-hint">默认跟随 Worker</span>
            </label>
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
          <div className="field">
            <label className="field-label">
              动态工作流 <span className="field-hint">Claude Code Workflows：多代理编排</span>
            </label>
            <Select
              value={dynamicWorkflow ? "on" : "off"}
              onChange={(value) => setDynamicWorkflow(value === "on")}
              options={[
                { value: "off", label: "否 · 关闭（默认）" },
                { value: "on", label: "是 · 启用动态工作流" }
              ]}
              disabled={busy}
              ariaLabel="动态工作流"
            />
          </div>
        </div>
        {autoReply ? (
          <div className="field">
            <label className="field-label">
              决策预案 <span className="field-hint">可选，喂给 Claude 当决策偏好（如“优先最小改动，跳过测试”）</span>
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
            定时发布 <span className="field-hint">留空即建为草稿手动发布；设定时间则到点自动进入待处理队列</span>
          </label>
          <DateTimePicker
            name="scheduledAt"
            defaultValue={scheduledAtDefault}
            minNow
            disabled={busy}
            placeholder="留空为草稿；选择时间则定时发布"
          />
        </div>
        <div className="field">
          <label className="field-label">
            前置任务 <span className="field-hint">同项目，可多选；前置全部「已完成 / 已合并」后才会被领取</span>
          </label>
          {depsReady && candidatesLoaded ? (
            <DependencyPicker candidates={depCandidates} value={dependsOn} onChange={setDependsOn} />
          ) : (
            <span className="field-hint">加载候选任务中…</span>
          )}
        </div>
      </section>

      {subRepos.length > 0 ? (
        <section className="form-section">
          <h3 className="form-section-title">子仓配置</h3>
          <SubRepoConfigSection subRepos={subRepos} subStates={subStates} onChange={setSubStates} />
        </section>
      ) : null}

      {error ? <div className="error-box">{error}</div> : null}
      <div className="form-actions">
        <button className="btn btn-sm" type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          className="btn btn-sm"
          type="submit"
          disabled={busy}
          onClick={() => {
            submitIntentRef.current = "save";
          }}
        >
          <Check size={14} />
          {busy ? "处理中…" : "保存"}
        </button>
        <button
          className="btn btn-primary btn-sm"
          type="submit"
          disabled={busy}
          onClick={() => {
            submitIntentRef.current = "publish";
          }}
          title="保存编辑并发布为「待处理」"
        >
          <Send size={14} />
          {busy ? "处理中…" : "保存并发布"}
        </button>
      </div>
    </form>
  );
}
