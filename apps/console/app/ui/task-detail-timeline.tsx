"use client";

import type { Task, TaskEvent } from "@claude-center/db";
import { Activity, ExternalLink, RotateCcw } from "lucide-react";
import { useState } from "react";
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

function hasPayload(event: TaskEvent): boolean {
  return Boolean(event.payload) && Object.keys(event.payload).length > 0;
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
                          {hasPayload(event) ? (
                            <details className="tl-payload">
                              <summary>详情</summary>
                              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                            </details>
                          ) : null}
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
