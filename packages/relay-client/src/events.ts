// relay 的事件契约：三端（apps/relay、apps/console、apps/worker）共用的单一事实源，避免各写一份漂移。
// 传输层只认「全量负载」信封，业务类型由 type 区分，payload 由发布方按领域 DTO 构造（传输层不耦合 db 类型）。

export type RelayEventType =
  | "conversation.message"
  | "conversation.upserted"
  | "conversation.session.updated"
  | "conversation.cancel"
  | "task.upserted"
  | "task.comment"
  | "task.event"
  | "task.session.updated"
  | "direct_command.upserted"
  | "worker.upserted"
  | "worker.working_state";

// relay 扇出给订阅者的事件信封。id 由 relay 在 /publish 时分配（单调递增），客户端用作 Last-Event-ID。
export interface RelayEvent {
  id: string;
  channel: string;
  type: RelayEventType;
  // 发布方时间戳（ms epoch）。
  ts: number;
  // 业务实体 id（taskId / conversationId / commandId / workerId），供订阅端按 entity 去重排序。
  entityId: string;
  projectId?: string;
  // 领域排序键：对话用 conversation_messages.seq，任务用 updated_at；订阅端据此丢弃陈旧/重复事件。
  seq?: number | string;
  // 发布方标识（如 "console" 或 workerId）。订阅端用它忽略自己发出的事件，避免「既发又订」的自触发循环。
  origin?: string;
  // 全量负载（行 DTO）。
  payload: unknown;
}

// 发布方提交给 /publish 的载荷（id/ts 由 relay 补齐）。
export interface RelayPublish {
  channel: string;
  type: RelayEventType;
  entityId: string;
  projectId?: string;
  seq?: number | string;
  origin?: string;
  payload: unknown;
}

// 频道命名：project:<id> 是 RBAC 的最小隔离单位；worker:<id> 定向单个 Worker。
export function projectChannel(projectId: string): string {
  return `project:${projectId}`;
}

export function workerChannel(workerId: string): string {
  return `worker:${workerId}`;
}
