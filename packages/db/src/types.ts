export type TaskStatus =
  | "draft"
  | "pending"
  | "claimed"
  | "running"
  | "waiting"
  | "success"
  | "merged"
  | "accepted"
  | "rejected"
  | "failed"
  | "cancelled";
export type TaskType = "work" | "qa";
// direct_commands 没有 merged 终态，沿用任务状态里除 merged 外的子集。
export type DirectCommandStatus = Exclude<TaskStatus, "merged">;
export type DirectCommandName = "shell" | "claude_prompt";
export type TaskSubmitMode = "pr" | "push";

export type Role = "admin" | "publisher" | "commenter" | "viewer";

export type User = {
  id: string;
  username: string;
  role: Role;
  display_name: string;
  disabled: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
};

// 列表视图：附带分配的项目 id（admin 不受范围约束，前端按 role 区分）。
export type UserWithProjects = User & {
  project_ids: string[];
};

export type Session = {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
};

export type Project = {
  id: string;
  name: string;
  repo_url: string;
  default_branch: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Worker = {
  id: string;
  name: string;
  host_name: string;
  app_version: string;
  status: "online" | "offline";
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type WorkerProjectLink = {
  id: string;
  worker_id: string;
  project_id: string;
  local_path: string;
  repo_identity: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type Task = {
  id: string;
  project_id: string;
  project_name?: string;
  task_type: TaskType;
  title: string;
  description: string;
  base_branch: string;
  work_branch: string;
  target_branch: string;
  submit_mode: TaskSubmitMode;
  target_files: string[];
  priority: number;
  status: TaskStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  result: Record<string, unknown>;
  pr_url: string | null;
  merge_checked_at: string | null;
  claude_session_id: string | null;
  // 前置任务 id（listRecentTasks 聚合填充；其余查询不返回，故可选）。
  depends_on?: string[];
  // 存在「状态非 accepted 的前置」时为 true，用于 UI 提示阻塞（同上，可选）。
  blocked?: boolean;
  created_at: string;
  updated_at: string;
};

export type TaskEvent = {
  id: string;
  task_id: string;
  worker_id: string | null;
  event_type: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type TaskCommentAuthor = "worker" | "user";

export type TaskComment = {
  id: string;
  task_id: string;
  author: TaskCommentAuthor;
  worker_id: string | null;
  body: string;
  created_at: string;
};

export type DirectCommand = {
  id: string;
  worker_id: string;
  worker_name?: string;
  command: DirectCommandName;
  payload: Record<string, unknown>;
  status: DirectCommandStatus;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};
