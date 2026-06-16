"use client";

import type { TaskEvent } from "@claude-center/db";
import { Activity } from "lucide-react";
import { Empty, fmtTime } from "./shared";
import { EVENT_LABEL, Section, type LifecycleStep } from "./task-detail-shared";

// 时间线 Tab：lifecycle 阶段头 + task_events 时间轴。
export function TimelineTab({
  events,
  lifecycle
}: {
  events: TaskEvent[];
  lifecycle: LifecycleStep[];
}) {
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
          <div className="timeline">
            {events.map((event) => (
              <div className="tl-item" key={event.id}>
                <span className="tl-node done" />
                <div>
                  <div className="tl-label">
                    {EVENT_LABEL[event.event_type] ?? event.event_type}
                    {event.message ? <span className="tl-msg"> · {event.message}</span> : null}
                  </div>
                  <div className="tl-time">{fmtTime(event.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty icon={<Activity size={24} />} text="暂无执行事件" />
        )}
      </Section>
    </div>
  );
}
