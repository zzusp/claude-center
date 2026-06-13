export type TaskStatus = "pending" | "claimed" | "running" | "waiting" | "success" | "failed" | "cancelled";
export type DirectCommandStatus = TaskStatus;
export type DirectCommandName = "shell" | "claude_prompt";

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
  title: string;
  description: string;
  base_branch: string;
  work_branch: string;
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
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
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
