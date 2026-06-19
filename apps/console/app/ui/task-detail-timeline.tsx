"use client";

import type { Task, TaskEvent } from "@claude-center/db";
import { Activity, ExternalLink, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Empty, fmtTime } from "./shared";
import {
  EXECUTION_LINK_EVENTS,
  FAILURE_EVENTS,
  ROUND_START_EVENTS,
  Section,
  eventMeta,
  type LifecycleStep
} from "./task-detail-shared";

type Round = { key: string; title: string; events: TaskEvent[] };

// 把按时间升序的 task_events 切成「执行轮次」:每个执行起点事件(running/resumed/rerun_started/
// retry_started)开启新一轮;起点之前的事件(创建/发布/认领)归入「准备」轮。失败重试 / 打回重跑会形成
// 多轮,据此折叠展示「第几次尝试」。
function groupRounds(events: TaskEvent[]): Round[] {
  const rounds: Round[] = [];
  let runIndex = 0;
  for (const event of events) {
    const isStart = ROUND_START_EVENTS.has(event.event_type);
    if (isStart || rounds.length === 0) {
      if (isStart) runIndex += 1;
      rounds.push({
        key: event.id,
        title: isStart ? `第 ${runIndex} 轮 · ${eventMeta(event.event_type).label}` : "准备 · 创建与排队",
        events: []
      });
    }
    rounds[rounds.length - 1]!.events.push(event);
  }
  return rounds;
}

// payload 字段 → 中文标签 + 取值渲染方式。把 worker 落库的原始 JSON 翻成用户看得懂的「字段 · 值」,
// 数组顺序即展示顺序。未登记的键回退原样列出,改了 worker 也不丢信息。
type PayloadFieldKind = "text" | "link" | "bool" | "branch" | "repo";
const PAYLOAD_FIELDS: { key: string; label: string; kind?: PayloadFieldKind }[] = [
  { key: "repoRole", label: "仓库", kind: "repo" },
  { key: "relativePath", label: "子仓路径" },
  { key: "workBranch", label: "工作分支", kind: "branch" },
  { key: "targetBranch", label: "目标分支", kind: "branch" },
  { key: "prUrl", label: "PR 链接", kind: "link" },
  { key: "fresh", label: "全新工作树", kind: "bool" },
  { key: "reused", label: "复用已有 PR", kind: "bool" },
  { key: "reusedCommit", label: "复用上一轮提交", kind: "bool" },
  { key: "resume", label: "恢复原会话", kind: "bool" },
  { key: "injected", label: "执行中注入留言", kind: "bool" },
  { key: "hitSentinel", label: "命中确认哨兵", kind: "bool" },
  { key: "round", label: "自动回复轮次" },
  { key: "usedRounds", label: "已用自动回复轮次" },
  { key: "outcome", label: "依赖预热结果" },
  { key: "question", label: "向用户提出的问题", kind: "text" },
  { key: "reply", label: "自动回复内容", kind: "text" },
  { key: "resultPreview", label: "本轮执行结果", kind: "text" },
  { key: "error", label: "错误信息", kind: "text" }
];

const REPO_ROLE_LABEL: Record<string, string> = { main: "主仓", sub: "子仓" };

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

// 单个 payload 字段一行:已知字段按 kind 渲染(链接可点 / 布尔译成是否 / 长文成块 / 分支用等宽),
// 未登记字段(extra)兜底原样字符串化。
function PayloadRow({ label, kind, value }: { label: string; kind?: PayloadFieldKind; value: unknown }) {
  let body: ReactNode;
  if (kind === "bool") {
    body = value ? "是" : "否";
  } else if (kind === "link" && typeof value === "string") {
    body = (
      <a className="tl-kv-link" href={value} target="_blank" rel="noreferrer">
        {value} <ExternalLink size={11} />
      </a>
    );
  } else if (kind === "text") {
    body = <pre className="tl-kv-text">{String(value)}</pre>;
  } else if (kind === "branch") {
    body = <code className="tl-kv-code">{String(value)}</code>;
  } else if (kind === "repo") {
    body = REPO_ROLE_LABEL[String(value)] ?? String(value);
  } else {
    body = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return (
    <div className={`tl-kv-row${kind === "text" ? " tl-kv-block" : ""}`}>
      <dt>{label}</dt>
      <dd>{body}</dd>
    </div>
  );
}

// 事件 payload 友好详情:把原始 JSON 翻成中文字段表,collapse 默认收起。无可展示字段时不渲染。
function PayloadDetails({ payload }: { payload: Record<string, unknown> }) {
  const known = PAYLOAD_FIELDS.filter((field) => !isEmptyValue(payload[field.key]));
  const extraKeys = Object.keys(payload).filter(
    (key) => !PAYLOAD_FIELDS.some((field) => field.key === key) && !isEmptyValue(payload[key])
  );
  if (known.length === 0 && extraKeys.length === 0) return null;
  return (
    <details className="tl-payload">
      <summary>详情</summary>
      <dl className="tl-kv">
        {known.map((field) => (
          <PayloadRow key={field.key} label={field.label} kind={field.kind} value={payload[field.key]} />
        ))}
        {extraKeys.map((key) => (
          <PayloadRow key={key} label={key} value={payload[key]} />
        ))}
      </dl>
    </details>
  );
}

// 时间线 Tab：lifecycle 阶段头(粗) + 按轮次折叠的细颗粒度事件流。失败/取消的最后一个节点挂「续接重试」，
// 执行类节点提供跳「Claude Code 执行」Tab 看 transcript。
export function TimelineTab({
  events,
  lifecycle,
  task,
  canRetry,
  onRetry,
  onJumpToExecution
}: {
  events: TaskEvent[];
  lifecycle: LifecycleStep[];
  task: Task;
  canRetry: boolean;
  onRetry: () => void | Promise<void>;
  onJumpToExecution: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const rounds = groupRounds(events);
  // 任务当前停在 failed/cancelled 时,「续接重试」只挂在最后一个失败事件上(历史失败节点不重复挂)。
  const showRetryAt =
    canRetry && (task.status === "failed" || task.status === "cancelled")
      ? [...events].reverse().find((event) => FAILURE_EVENTS.has(event.event_type))?.id ?? null
      : null;

  async function handleRetry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="detail-tab-stack">
      <Section icon={<Activity size={15} />} title="执行阶段">
        <div className="lifecycle-bar">
          {lifecycle.map((item, index) => (
            <div className={`lc-step ${item.state}`} key={`tl-lc-${index}`}>
              <span className="lc-node" />
              <div className="lc-text">
                <div className="lc-label">{item.label}</div>
                <div className="lc-time">{item.time ? fmtTime(item.time) : "—"}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={<Activity size={15} />} title="事件流">
        {events.length > 0 ? (
          <div className="tl-rounds">
            {rounds.map((round, roundIndex) => (
              <details className="tl-round" key={round.key} open={roundIndex === rounds.length - 1}>
                <summary className="tl-round-head">
                  <span className="tl-round-title">{round.title}</span>
                  <span className="tl-round-count">{round.events.length} 个事件</span>
                </summary>
                <div className="timeline">
                  {round.events.map((event) => {
                    const meta = eventMeta(event.event_type);
                    return (
                      <div className="tl-item" key={event.id}>
                        <span className="tl-node" data-tone={meta.tone} />
                        <div className="tl-body">
                          <div className="tl-label">
                            {meta.label}
                            {event.message ? <span className="tl-msg"> · {event.message}</span> : null}
                          </div>
                          <div className="tl-meta">
                            <span className="tl-time">{fmtTime(event.created_at)}</span>
                            {EXECUTION_LINK_EVENTS.has(event.event_type) ? (
                              <button type="button" className="tl-link" onClick={onJumpToExecution}>
                                查看执行详情 <ExternalLink size={11} />
                              </button>
                            ) : null}
                          </div>
                          <PayloadDetails payload={event.payload} />
                          {showRetryAt === event.id ? (
                            <button
                              type="button"
                              className="btn btn-primary btn-sm tl-retry"
                              disabled={retrying}
                              onClick={() => void handleRetry()}
                            >
                              <RotateCcw size={14} />
                              {retrying ? "重试中…" : "续接重试"}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Empty icon={<Activity size={24} />} text="暂无执行事件" />
        )}
      </Section>
    </div>
  );
}
