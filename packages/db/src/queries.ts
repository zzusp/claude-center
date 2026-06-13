import type pg from "pg";
import type {
  DirectCommand,
  DirectCommandName,
  Project,
  Role,
  Task,
  TaskComment,
  TaskCommentAuthor,
  TaskEvent,
  TaskSubmitMode,
  TaskType,
  User,
  UserWithProjects,
  Worker
} from "./types.js";

export type WorkerRegistration = {
  id: string;
  name: string;
  hostName: string;
  appVersion: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type ProjectLinkInput = {
  workerId: string;
  projectName?: string;
  repoUrl?: string;
  localPath: string;
};

export async function listProjects(client: pg.Pool | pg.PoolClient): Promise<Project[]> {
  const result = await client.query<Project>(
    `SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC`
  );
  return result.rows;
}

export async function createProject(
  client: pg.Pool | pg.PoolClient,
  input: { name: string; repoUrl: string; defaultBranch: string; description: string }
): Promise<Project> {
  const result = await client.query<Project>(
    `INSERT INTO projects (name, repo_url, default_branch, description)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.name, input.repoUrl, input.defaultBranch, input.description]
  );
  return result.rows[0]!;
}

export async function getProject(client: pg.Pool | pg.PoolClient, id: string): Promise<Project | null> {
  const result = await client.query<Project>(`SELECT * FROM projects WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] ?? null;
}

export async function createTask(
  client: pg.Pool | pg.PoolClient,
  input: {
    projectId: string;
    taskType: TaskType;
    title: string;
    description: string;
    baseBranch: string;
    workBranch: string;
    targetBranch: string;
    submitMode: TaskSubmitMode;
    targetFiles: string[];
    priority: number;
  }
): Promise<Task> {
  const result = await client.query<Task>(
    `INSERT INTO tasks (project_id, task_type, title, description, base_branch, work_branch, target_branch, submit_mode, target_files, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.projectId,
      input.taskType,
      input.title,
      input.description,
      input.baseBranch,
      input.workBranch,
      input.targetBranch,
      input.submitMode,
      input.targetFiles,
      input.priority
    ]
  );
  return result.rows[0]!;
}

// 发布草稿任务：draft → pending，进入可认领队列。WHERE status='draft' 保证只有草稿
// 可发布，对已认领/运行中/已完成任务无副作用；未命中返回 null（任务不存在或非草稿）。
export async function publishTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'pending',
            updated_at = now()
      WHERE id = $1 AND status = 'draft'
      RETURNING *`,
    [taskId]
  );
  return result.rows[0] ?? null;
}

export async function listRecentTasks(client: pg.Pool | pg.PoolClient, limit = 50): Promise<Task[]> {
  const result = await client.query<Task>(
    `SELECT tasks.*,
            projects.name AS project_name,
            COALESCE(dep.depends_on, ARRAY[]::uuid[]) AS depends_on,
            COALESCE(dep.blocked, false) AS blocked
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       LEFT JOIN LATERAL (
         SELECT array_agg(d.depends_on_task_id) AS depends_on,
                bool_or(pre.status NOT IN ('accepted', 'merged')) AS blocked
           FROM task_dependencies d
           JOIN tasks pre ON pre.id = d.depends_on_task_id
          WHERE d.task_id = tasks.id
       ) dep ON true
      ORDER BY tasks.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// 为任务添加前置依赖（仅同项目）。在调用方事务内执行；校验前置存在且与本任务同项目。
export async function addTaskDependencies(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  dependsOnIds: string[]
): Promise<void> {
  if (dependsOnIds.length === 0) {
    return;
  }
  const unique = [...new Set(dependsOnIds)];
  if (unique.includes(taskId)) {
    throw new Error("任务不能依赖自身");
  }

  const check = await client.query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM tasks WHERE id = ANY($1::uuid[])`,
    [unique]
  );
  if (check.rows.length !== unique.length) {
    throw new Error("部分前置任务不存在");
  }
  const taskProject = await client.query<{ project_id: string }>(
    `SELECT project_id FROM tasks WHERE id = $1`,
    [taskId]
  );
  const projectId = taskProject.rows[0]?.project_id;
  if (check.rows.some((row) => row.project_id !== projectId)) {
    throw new Error("前置任务必须与本任务属于同一项目");
  }

  await client.query(
    `INSERT INTO task_dependencies (task_id, depends_on_task_id)
     SELECT $1, unnest($2::uuid[])
     ON CONFLICT DO NOTHING`,
    [taskId, unique]
  );
}

export type TaskSort = "updated" | "created" | "priority";

export type ListTasksFilters = {
  status?: string[];
  projectId?: string | null;
  // 项目级隔离：非 admin 传入其可访问项目 id 集合，约束只返回范围内任务（空集合 → 无结果）。
  projectIds?: string[] | null;
  q?: string | null;
  sort?: TaskSort;
  limit: number;
  offset: number;
};

// 排序白名单：避免把外部输入直接拼进 ORDER BY。
const TASK_SORT_SQL: Record<TaskSort, string> = {
  updated: "tasks.updated_at DESC",
  created: "tasks.created_at DESC",
  priority: "tasks.priority DESC, tasks.created_at DESC"
};

// 任务流分页/筛选查询：状态(多选) + 项目 + 关键词(标题/分支)；count(*) OVER() 单次拿总数。
export async function listTasks(
  client: pg.Pool | pg.PoolClient,
  filters: ListTasksFilters
): Promise<{ tasks: Task[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status && filters.status.length > 0) {
    params.push(filters.status);
    conditions.push(`tasks.status = ANY($${params.length}::text[])`);
  }
  if (filters.projectId) {
    params.push(filters.projectId);
    conditions.push(`tasks.project_id = $${params.length}`);
  }
  // 项目范围约束（非 admin）：与上面的单项目筛选用 AND 叠加，无法越过自己的范围。
  if (filters.projectIds) {
    params.push(filters.projectIds);
    conditions.push(`tasks.project_id = ANY($${params.length}::uuid[])`);
  }
  const keyword = filters.q?.trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    conditions.push(`(tasks.title ILIKE $${params.length} OR tasks.work_branch ILIKE $${params.length})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = TASK_SORT_SQL[filters.sort ?? "updated"];

  params.push(filters.limit);
  const limitIdx = params.length;
  params.push(filters.offset);
  const offsetIdx = params.length;

  const result = await client.query<Task & { total_count: string }>(
    `SELECT tasks.*, projects.name AS project_name, count(*) OVER() AS total_count
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       ${where}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  const tasks = result.rows.map(({ total_count: _total, ...task }) => task as Task);
  return { tasks, total };
}

export async function listTaskEvents(client: pg.Pool | pg.PoolClient, taskId: string): Promise<TaskEvent[]> {
  const result = await client.query<TaskEvent>(
    `SELECT * FROM task_events WHERE task_id = $1 ORDER BY created_at ASC`,
    [taskId]
  );
  return result.rows;
}

export async function listWorkers(client: pg.Pool | pg.PoolClient): Promise<Worker[]> {
  const result = await client.query<Worker>(
    `SELECT *,
            CASE WHEN last_seen_at > now() - interval '60 seconds' THEN 'online' ELSE 'offline' END AS status
       FROM workers
      ORDER BY last_seen_at DESC`
  );
  return result.rows;
}

export async function registerWorker(client: pg.Pool | pg.PoolClient, input: WorkerRegistration): Promise<Worker> {
  const result = await client.query<Worker>(
    `INSERT INTO workers (id, name, host_name, app_version, capabilities, metadata, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'online', now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       host_name = EXCLUDED.host_name,
       app_version = EXCLUDED.app_version,
       capabilities = EXCLUDED.capabilities,
       metadata = EXCLUDED.metadata,
       status = 'online',
       last_seen_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      input.id,
      input.name,
      input.hostName,
      input.appVersion,
      input.capabilities ?? {},
      input.metadata ?? {}
    ]
  );
  return result.rows[0]!;
}

export async function heartbeatWorker(client: pg.Pool | pg.PoolClient, workerId: string): Promise<void> {
  await client.query(
    `UPDATE workers
        SET status = 'online', last_seen_at = now(), updated_at = now()
      WHERE id = $1`,
    [workerId]
  );
}

export async function upsertWorkerProjectLink(
  client: pg.Pool | pg.PoolClient,
  input: ProjectLinkInput
): Promise<void> {
  const match = await client.query<{ id: string; name: string; repo_url: string }>(
    `SELECT id, name, repo_url
       FROM projects
      WHERE ($1::text IS NOT NULL AND name = $1)
         OR ($2::text IS NOT NULL AND repo_url = $2)
      LIMIT 1`,
    [input.projectName ?? null, input.repoUrl ?? null]
  );

  const project = match.rows[0];
  if (!project) {
    return;
  }

  await client.query(
    `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity, enabled)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (worker_id, project_id, local_path) DO UPDATE SET
       repo_identity = EXCLUDED.repo_identity,
       enabled = true,
       updated_at = now()`,
    [input.workerId, project.id, input.localPath, input.repoUrl ?? project.repo_url]
  );
}

export async function claimNextTask(client: pg.Pool | pg.PoolClient, workerId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `WITH candidate AS (
       SELECT tasks.id
         FROM tasks
         JOIN worker_project_links ON worker_project_links.project_id = tasks.project_id
        WHERE tasks.status = 'pending'
          AND worker_project_links.worker_id = $1
          AND worker_project_links.enabled = true
          -- 同 worker 在该项目已有「等待用户回复的工作类任务」时，不领新任务：该任务
          -- 工作树有未提交改动，新任务会在同一本地工作树 git checkout 清掉它。问答类
          -- 等待任务是只读对话、不持有改动，不锁工作树，故不阻止领新任务。
          AND NOT EXISTS (
            SELECT 1
              FROM tasks waiting
             WHERE waiting.project_id = tasks.project_id
               AND waiting.claimed_by = $1
               AND waiting.status = 'waiting'
               AND waiting.task_type = 'work'
          )
          -- 前置依赖门控：任一前置任务未到达「已完成」终态则不可领取。已完成 = accepted
          -- （人工验收通过）或 merged（PR 已合并清理 / 直推已落地，工作已进目标分支）。
          AND NOT EXISTS (
            SELECT 1
              FROM task_dependencies dep
              JOIN tasks pre ON pre.id = dep.depends_on_task_id
             WHERE dep.task_id = tasks.id
               AND pre.status NOT IN ('accepted', 'merged')
          )
        ORDER BY tasks.priority DESC, tasks.created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tasks
        SET status = 'claimed',
            claimed_by = $1,
            claimed_at = now(),
            updated_at = now()
       FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

export async function getTaskLocalPath(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string
): Promise<string | null> {
  const result = await client.query<{ local_path: string }>(
    `SELECT worker_project_links.local_path
       FROM tasks
       JOIN worker_project_links ON worker_project_links.project_id = tasks.project_id
      WHERE tasks.id = $1
        AND worker_project_links.worker_id = $2
        AND worker_project_links.enabled = true
      LIMIT 1`,
    [taskId, workerId]
  );
  return result.rows[0]?.local_path ?? null;
}

export async function markTaskRunning(client: pg.Pool | pg.PoolClient, taskId: string, workerId: string): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET status = 'running',
            started_at = now(),
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId]
  );
  await addTaskEvent(client, taskId, workerId, "running", "Task execution started", {});
}

export async function markTaskSuccess(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  resultPayload: Record<string, unknown>,
  prUrl: string | null
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET status = 'success',
            finished_at = now(),
            result = $3,
            pr_url = $4,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId, resultPayload, prUrl]
  );
  await addTaskEvent(client, taskId, workerId, "success", "Task completed", resultPayload);
}

export async function markTaskFailed(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  errorMessage: string,
  resultPayload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET status = 'failed',
            finished_at = now(),
            error_message = $3,
            result = $4,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId, errorMessage, resultPayload]
  );
  await addTaskEvent(client, taskId, workerId, "failed", errorMessage, resultPayload);
}

// 人工验收通过：仅 success 可验收，翻为终态 accepted。返回 null 表示任务不在待验收态。
// 在调用方事务内执行。
export async function acceptTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'accepted', updated_at = now()
      WHERE id = $1 AND status = 'success'
      RETURNING *`,
    [taskId]
  );
  const task = result.rows[0];
  if (!task) {
    return null;
  }
  await addTaskEvent(client, taskId, null, "accepted", "Task accepted by user", {});
  return task;
}

// 人工验收打回：仅 success 可打回。先落打回意见为 user 评论（供 Worker 续接读取），再翻
// 为 rejected。必须与翻转同事务，避免 Worker 在「已 rejected 但评论未落」窗口领走空跑。
export async function rejectTask(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  feedback: string
): Promise<Task | null> {
  const guard = await client.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id = $1 AND status = 'success' FOR UPDATE`,
    [taskId]
  );
  if (!guard.rows[0]) {
    return null;
  }
  await addTaskComment(client, { taskId, author: "user", workerId: null, body: feedback });
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'rejected', finished_at = NULL, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [taskId]
  );
  await addTaskEvent(client, taskId, null, "rejected", "Task sent back by user", { feedback });
  return result.rows[0]!;
}

// PR 已合并并完成本地清理 / 直推（submit_mode='push'）已落地：进入终态 merged。resultPayload
// 合并进既有 result，不丢之前 success 阶段写入的内容；finished_at 只在首次设置（直推无 success 中间态）。
export async function markTaskMerged(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  resultPayload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET status = 'merged',
            finished_at = COALESCE(finished_at, now()),
            merge_checked_at = now(),
            result = result || $3::jsonb,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId, resultPayload]
  );
  await addTaskEvent(client, taskId, workerId, "merged", "Task merged and cleaned up", resultPayload);
}

// 清理候选（PR 模式）：本 worker 的、已建 PR 的 success 任务，按 merge_checked_at 轮转取最久未查
// 的一个（NULL 优先）。只读不翻状态——是否清理由 cleanupMergedTask 依据 PR 合并状态决定。
export async function claimNextCleanupCandidate(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `SELECT *
       FROM tasks
      WHERE status = 'success'
        AND claimed_by = $1
        AND pr_url IS NOT NULL
      ORDER BY merge_checked_at ASC NULLS FIRST
      LIMIT 1`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// PR 尚未合并：仅打检查时间戳，让该任务退到轮转队尾，下次优先查更久未查的。
export async function setTaskMergeChecked(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET merge_checked_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId]
  );
}

// 用户在对话区点「结束对话」：把问答类任务收口为 success。仅作用于 task_type='qa'，
// 避免误关工作类任务（工作类的收尾由 Worker 按 git 改动驱动）。
export async function completeQaTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'success',
            finished_at = now(),
            result = result || '{"closedByUser": true}'::jsonb,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1
        AND task_type = 'qa'
        AND status IN ('pending', 'claimed', 'running', 'waiting', 'failed')
      RETURNING *`,
    [taskId]
  );
  return result.rows[0] ?? null;
}

// 续接：认领本 Worker 自己的、已收到新用户回复的等待中任务（原子翻转为 running）。
// 「新回复」= 存在比最后一条 worker 评论更晚的 user 评论。
export async function claimNextResumableTask(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `WITH candidate AS (
       SELECT tasks.id
         FROM tasks
        WHERE tasks.status = 'waiting'
          AND tasks.claimed_by = $1
          AND EXISTS (
            SELECT 1
              FROM task_comments uc
             WHERE uc.task_id = tasks.id
               AND uc.author = 'user'
               AND uc.created_at > COALESCE(
                 (SELECT max(wc.created_at)
                    FROM task_comments wc
                   WHERE wc.task_id = tasks.id AND wc.author = 'worker'),
                 'epoch'::timestamptz)
          )
        ORDER BY tasks.updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tasks
        SET status = 'running',
            updated_at = now()
       FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// 打回重跑：认领本 Worker 自己的、被人工打回的任务（原子翻转为 running）。打回时已落
// 打回意见评论，claimed_by 在首轮已锁定同机，保证同工作树 + 同机 Claude 会话磁盘。
export async function claimNextRejectedTask(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `WITH candidate AS (
       SELECT tasks.id
         FROM tasks
        WHERE tasks.status = 'rejected'
          AND tasks.claimed_by = $1
        ORDER BY tasks.updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tasks
        SET status = 'running',
            updated_at = now()
       FROM candidate
      WHERE tasks.id = candidate.id
      RETURNING tasks.*`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// 任务暂停等待用户回复：记下续接所需的 Claude session id。
export async function setTaskWaiting(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  sessionId: string | null
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET status = 'waiting',
            claude_session_id = COALESCE($3, claude_session_id),
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId, sessionId]
  );
}

export async function setTaskClaudeSession(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  sessionId: string
): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET claude_session_id = $3, updated_at = now()
      WHERE id = $1 AND claimed_by = $2`,
    [taskId, workerId, sessionId]
  );
}

export async function addTaskComment(
  client: pg.Pool | pg.PoolClient,
  input: { taskId: string; author: TaskCommentAuthor; workerId: string | null; body: string }
): Promise<TaskComment> {
  const result = await client.query<TaskComment>(
    `INSERT INTO task_comments (task_id, author, worker_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.taskId, input.author, input.workerId, input.body]
  );
  return result.rows[0]!;
}

export async function listTaskComments(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<TaskComment[]> {
  const result = await client.query<TaskComment>(
    `SELECT * FROM task_comments WHERE task_id = $1 ORDER BY created_at ASC`,
    [taskId]
  );
  return result.rows;
}

// 取「最后一条 worker 评论之后」的所有 user 评论，按时间拼接为续接回复。
export async function getPendingReply(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<string | null> {
  const result = await client.query<{ reply: string | null }>(
    `SELECT string_agg(body, E'\n\n' ORDER BY created_at) AS reply
       FROM task_comments
      WHERE task_id = $1
        AND author = 'user'
        AND created_at > COALESCE(
          (SELECT max(created_at) FROM task_comments WHERE task_id = $1 AND author = 'worker'),
          'epoch'::timestamptz)`,
    [taskId]
  );
  return result.rows[0]?.reply ?? null;
}

export async function addTaskEvent(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string | null,
  eventType: string,
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO task_events (task_id, worker_id, event_type, message, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [taskId, workerId, eventType, message, payload]
  );
}

export async function createDirectCommand(
  client: pg.Pool | pg.PoolClient,
  input: { workerId: string; command: DirectCommandName; payload: Record<string, unknown> }
): Promise<DirectCommand> {
  const result = await client.query<DirectCommand>(
    `INSERT INTO direct_commands (worker_id, command, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.workerId, input.command, input.payload]
  );
  return result.rows[0]!;
}

export async function listRecentDirectCommands(
  client: pg.Pool | pg.PoolClient,
  limit = 30
): Promise<DirectCommand[]> {
  const result = await client.query<DirectCommand>(
    `SELECT direct_commands.*, workers.name AS worker_name
       FROM direct_commands
       JOIN workers ON workers.id = direct_commands.worker_id
      ORDER BY direct_commands.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function claimNextDirectCommand(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<DirectCommand | null> {
  const result = await client.query<DirectCommand>(
    `WITH candidate AS (
       SELECT id
         FROM direct_commands
        WHERE worker_id = $1
          AND status = 'pending'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE direct_commands
        SET status = 'claimed',
            claimed_at = now(),
            updated_at = now()
       FROM candidate
      WHERE direct_commands.id = candidate.id
      RETURNING direct_commands.*`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

export async function markDirectCommandRunning(
  client: pg.Pool | pg.PoolClient,
  commandId: string,
  workerId: string
): Promise<void> {
  await client.query(
    `UPDATE direct_commands
        SET status = 'running', started_at = now(), updated_at = now()
      WHERE id = $1 AND worker_id = $2`,
    [commandId, workerId]
  );
}

export async function markDirectCommandSuccess(
  client: pg.Pool | pg.PoolClient,
  commandId: string,
  workerId: string,
  resultPayload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE direct_commands
        SET status = 'success',
            finished_at = now(),
            error_message = NULL,
            result = $3,
            updated_at = now()
      WHERE id = $1 AND worker_id = $2`,
    [commandId, workerId, resultPayload]
  );
}

export async function markDirectCommandFailed(
  client: pg.Pool | pg.PoolClient,
  commandId: string,
  workerId: string,
  errorMessage: string,
  resultPayload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `UPDATE direct_commands
        SET status = 'failed',
            finished_at = now(),
            error_message = $3,
            result = $4,
            updated_at = now()
      WHERE id = $1 AND worker_id = $2`,
    [commandId, workerId, errorMessage, resultPayload]
  );
}

/* ============================== 用户 / 角色 / 权限 / 会话 ==============================
 * 密码散列 / 会话 token 全用 pgcrypto（见 migration 008）。所有读取都不返回 password_hash。
 */

const USER_COLS = "id, username, role, display_name, disabled, last_login_at, created_at, updated_at";

// 登录校验：用 crypt(输入, hash) = hash 比对（pgcrypto bf）。命中返回用户（含 disabled，由调用方判断），否则 null。
export async function verifyUserCredentials(
  client: pg.Pool | pg.PoolClient,
  username: string,
  password: string
): Promise<User | null> {
  const result = await client.query<User>(
    `SELECT ${USER_COLS}
       FROM users
      WHERE username = $1
        AND password_hash = crypt($2, password_hash)
      LIMIT 1`,
    [username, password]
  );
  return result.rows[0] ?? null;
}

export async function touchUserLogin(client: pg.Pool | pg.PoolClient, userId: string): Promise<void> {
  await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
}

// 建会话：token 由 DB 端 gen_random_bytes 生成，返回明文 token 写进 cookie。默认 7 天过期。
export async function createSession(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  ttlDays = 7
): Promise<string> {
  const result = await client.query<{ token: string }>(
    `INSERT INTO sessions (user_id, expires_at)
     VALUES ($1, now() + make_interval(days => $2::int))
     RETURNING token`,
    [userId, ttlDays]
  );
  return result.rows[0]!.token;
}

// 实时查会话对应的用户（校验未过期且账号未停用）。每次请求都查，所以改角色/项目/停用立即生效。
export async function getSessionUser(client: pg.Pool | pg.PoolClient, token: string): Promise<User | null> {
  const result = await client.query<User>(
    `SELECT u.id, u.username, u.role, u.display_name, u.disabled, u.last_login_at, u.created_at, u.updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1
        AND s.expires_at > now()
        AND u.disabled = false
      LIMIT 1`,
    [token]
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(client: pg.Pool | pg.PoolClient, token: string): Promise<void> {
  await client.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

export async function listUsersWithProjects(client: pg.Pool | pg.PoolClient): Promise<UserWithProjects[]> {
  const result = await client.query<UserWithProjects>(
    `SELECT u.id, u.username, u.role, u.display_name, u.disabled, u.last_login_at, u.created_at, u.updated_at,
            COALESCE(array_agg(upl.project_id) FILTER (WHERE upl.project_id IS NOT NULL), ARRAY[]::uuid[]) AS project_ids
       FROM users u
       LEFT JOIN user_project_links upl ON upl.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC`
  );
  return result.rows;
}

export async function createUser(
  client: pg.Pool | pg.PoolClient,
  input: { username: string; password: string; role: Role; displayName: string }
): Promise<User> {
  const result = await client.query<User>(
    `INSERT INTO users (username, password_hash, role, display_name)
     VALUES ($1, crypt($2, gen_salt('bf')), $3, $4)
     RETURNING ${USER_COLS}`,
    [input.username, input.password, input.role, input.displayName]
  );
  return result.rows[0]!;
}

// 局部更新：未传的字段保持不变（COALESCE）。密码单独走 setUserPassword。
export async function updateUser(
  client: pg.Pool | pg.PoolClient,
  id: string,
  patch: { role?: Role; displayName?: string; disabled?: boolean }
): Promise<User | null> {
  const result = await client.query<User>(
    `UPDATE users
        SET role = COALESCE($2::text, role),
            display_name = COALESCE($3::text, display_name),
            disabled = COALESCE($4::boolean, disabled),
            updated_at = now()
      WHERE id = $1
      RETURNING ${USER_COLS}`,
    [id, patch.role ?? null, patch.displayName ?? null, patch.disabled ?? null]
  );
  return result.rows[0] ?? null;
}

export async function setUserPassword(
  client: pg.Pool | pg.PoolClient,
  id: string,
  password: string
): Promise<void> {
  await client.query(
    `UPDATE users SET password_hash = crypt($2, gen_salt('bf')), updated_at = now() WHERE id = $1`,
    [id, password]
  );
}

// 重置用户的项目分配：先清空再按新集合写入（unnest 批量插）。空集合即取消全部分配。
export async function setUserProjects(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  projectIds: string[]
): Promise<void> {
  await client.query(`DELETE FROM user_project_links WHERE user_id = $1`, [userId]);
  if (projectIds.length > 0) {
    await client.query(
      `INSERT INTO user_project_links (user_id, project_id)
       SELECT $1, x FROM unnest($2::uuid[]) AS x`,
      [userId, projectIds]
    );
  }
}

export async function getUserById(client: pg.Pool | pg.PoolClient, id: string): Promise<User | null> {
  const result = await client.query<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] ?? null;
}

export async function deleteUser(client: pg.Pool | pg.PoolClient, id: string): Promise<void> {
  await client.query(`DELETE FROM users WHERE id = $1`, [id]);
}

// 防自锁：统计「可用的」管理员数（未停用）。删除/降级最后一个 admin 前用它兜底。
export async function countActiveAdmins(client: pg.Pool | pg.PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND disabled = false`
  );
  return Number(result.rows[0]?.count ?? 0);
}

/* ============================== 项目级隔离（按用户范围过滤） ============================== */

// admin 看全部项目；其余只看分配给自己的项目。
export async function listProjectsForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role }
): Promise<Project[]> {
  if (user.role === "admin") {
    return listProjects(client);
  }
  const result = await client.query<Project>(
    `SELECT projects.*
       FROM projects
       JOIN user_project_links upl ON upl.project_id = projects.id
      WHERE upl.user_id = $1
        AND projects.archived_at IS NULL
      ORDER BY projects.created_at DESC`,
    [user.id]
  );
  return result.rows;
}

// admin 看全部任务；其余只看范围内项目的任务。
export async function listRecentTasksForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role },
  limit = 50
): Promise<Task[]> {
  if (user.role === "admin") {
    return listRecentTasks(client, limit);
  }
  const result = await client.query<Task>(
    `SELECT tasks.*, projects.name AS project_name
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2
      ORDER BY tasks.created_at DESC
      LIMIT $1`,
    [limit, user.id]
  );
  return result.rows;
}

export async function userHasProject(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  projectId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM user_project_links WHERE user_id = $1 AND project_id = $2 LIMIT 1`,
    [userId, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

// 某用户被分配的项目 id 列表（用于把任务列表查询约束在范围内）。
export async function listUserProjectIds(
  client: pg.Pool | pg.PoolClient,
  userId: string
): Promise<string[]> {
  const result = await client.query<{ project_id: string }>(
    `SELECT project_id FROM user_project_links WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map((row) => row.project_id);
}

export async function getTaskProjectId(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<string | null> {
  const result = await client.query<{ project_id: string }>(
    `SELECT project_id FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId]
  );
  return result.rows[0]?.project_id ?? null;
}
