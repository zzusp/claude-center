export type TaskStatus =
  | "draft"
  | "scheduled"
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
// 合并状态：Console 定时检查 work_branch 是否已并入 target_branch 的结果。unknown 未检查。
export type MergeStatus = "unknown" | "unmerged" | "merged";
// direct_commands 没有 merged 终态，也没有 scheduled 定时态，沿用任务状态里的子集。
export type DirectCommandStatus = Exclude<TaskStatus, "merged" | "scheduled">;
export type DirectCommandName = "shell" | "claude_prompt";
export type TaskSubmitMode = "pr" | "push";
// 任务级 Claude 执行模型：'default' 不指定（Worker 执行时不传 --model，跟随 claude 自身默认），
// 其余由 Worker 映射为 `claude --model <alias>`。
export type TaskModel = "default" | "opus" | "sonnet" | "haiku";

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

// 套餐订阅用量窗口：oauth/usage 给的是利用率百分比（0–100）+ 重置时间，没有绝对额度。
export type UsageWindow = { utilization: number; resets_at: string };
export type WorkerUsage = {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at?: string;
};

// 订阅类型：套餐档位 / api（按量计费）/ unknown（未识别）。
export type WorkerSubscriptionType = "max" | "pro" | "team" | "enterprise" | "api" | "unknown";

// 在线 ≠ 接任务：idle 时 worker 不领新任务，working 才领。
export type WorkerWorkingState = "idle" | "working";

export type Worker = {
  id: string;
  name: string;
  host_name: string;
  app_version: string;
  status: "online" | "offline";
  // worker 机器上 claude CLI 版本（如 "2.1.177"），未采集到为 null。
  claude_version: string | null;
  subscription_type: WorkerSubscriptionType;
  // 仅套餐账号有意义；api/unknown 或采集失败时为空对象。
  usage: WorkerUsage;
  working_state: WorkerWorkingState;
  allow_remote_control: boolean;
  max_parallel: number;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  // listWorkers 派生：该 worker 当前在途（claimed/running）任务数。
  active_task_count?: number;
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

// listWorkerProjectLinks 视图:worker 关联 + 项目展示信息（join projects）。worker 桌面端「关联项目」面板用。
export type WorkerProjectLinkView = {
  project_id: string;
  local_path: string;
  enabled: boolean;
  project_name: string;
  repo_url: string;
  default_branch: string;
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
  // 自动合并 PR：仅 submit_mode='pr' 时有意义；Worker 建 PR 后自动执行 gh pr merge --merge。
  auto_merge_pr: boolean;
  // 任务级 Claude 执行模型，见 TaskModel；'default' 表示 Worker 执行时不传 --model。
  model: TaskModel;
  status: TaskStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  result: Record<string, unknown>;
  pr_url: string | null;
  merge_checked_at: string | null;
  // Console 定时检查 work_branch→target_branch 的合并状态；merge_status_checked_at 为其轮转游标。
  merge_status: MergeStatus;
  merge_status_checked_at: string | null;
  claude_session_id: string | null;
  // 定时发布时间：scheduled 任务到此刻自动转 pending；非定时任务为 null。
  scheduled_at: string | null;
  // 取消请求时间戳：Console 对在途任务打此戳；Worker 扫到后杀进程并翻为 cancelled。未请求为 null。
  cancel_requested_at: string | null;
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
