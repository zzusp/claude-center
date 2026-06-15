import type pg from "pg";
import type {
  Conversation,
  ConversationMessage,
  ConversationMessageRole,
  DirectCommand,
  DirectCommandName,
  Project,
  Role,
  Task,
  TaskComment,
  TaskCommentAuthor,
  TaskEvent,
  TaskModel,
  TaskSubmitMode,
  User,
  UserWithProjects,
  Worker,
  WorkerProjectLinkView
} from "./types.js";

export type WorkerRegistration = {
  id: string;
  name: string;
  hostName: string;
  appVersion: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  // 客户端策略与并行上限：register 写入初值，运行时经 updateWorkerInfo 刷新。
  allowRemoteControl?: boolean;
  maxParallel?: number;
};

// worker 周期性上报的动态信息（claude 版本 / 订阅 / 用量）+ 当前客户端策略。
export type WorkerInfoUpdate = {
  claudeVersion: string | null;
  subscriptionType: string;
  usage: Record<string, unknown>;
  allowRemoteControl: boolean;
  maxParallel: number;
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

export async function updateProject(
  client: pg.Pool | pg.PoolClient,
  id: string,
  input: { name: string; repoUrl: string; defaultBranch: string; description: string }
): Promise<Project | null> {
  const result = await client.query<Project>(
    `UPDATE projects
        SET name = $2,
            repo_url = $3,
            default_branch = $4,
            description = $5,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, input.name, input.repoUrl, input.defaultBranch, input.description]
  );
  return result.rows[0] ?? null;
}

// 删除项目：其下任务及关联记录由外键 ON DELETE CASCADE 自动级联删除
// （tasks / worker_project_links / user_project_links → 再到 task_events / task_comments /
// task_dependencies）。删前点数其下任务条数，供调用方回报「含 N 个任务」。deleted=false 表示项目不存在。
export async function deleteProject(
  client: pg.Pool | pg.PoolClient,
  id: string
): Promise<{ deleted: boolean; taskCount: number }> {
  const counted = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks WHERE project_id = $1`,
    [id]
  );
  const result = await client.query(`DELETE FROM projects WHERE id = $1`, [id]);
  return { deleted: (result.rowCount ?? 0) > 0, taskCount: counted.rows[0]?.count ?? 0 };
}

export async function createTask(
  client: pg.Pool | pg.PoolClient,
  input: {
    projectId: string;
    title: string;
    description: string;
    baseBranch: string;
    workBranch: string;
    targetBranch: string;
    submitMode: TaskSubmitMode;
    // 自动合并 PR：仅 PR 模式有意义，Worker 建 PR 后自动 gh pr merge --merge。
    autoMergePr: boolean;
    // 任务级 Claude 执行模型；'default' 表示 Worker 执行时不传 --model。
    model: TaskModel;
    // 指定发布时间则落 'scheduled' 定时态，到点由调度器转 pending；为空走默认 'draft'。
    scheduledAt?: string | null;
  }
): Promise<Task> {
  const scheduledAt = input.scheduledAt ?? null;
  const status = scheduledAt ? "scheduled" : "draft";
  const result = await client.query<Task>(
    `INSERT INTO tasks (project_id, title, description, base_branch, work_branch, target_branch, submit_mode, model, auto_merge_pr, status, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.projectId,
      input.title,
      input.description,
      input.baseBranch,
      input.workBranch,
      input.targetBranch,
      input.submitMode,
      input.model,
      input.autoMergePr,
      status,
      scheduledAt
    ]
  );
  return result.rows[0]!;
}

// 发布任务：draft / scheduled → pending，进入可认领队列。对 scheduled 任务即「立即发布」
// （到点前手动提前发布，覆盖定时）。WHERE 限定初始态保证对已认领/运行中/已完成任务无副作用；
// 未命中返回 null（任务不存在或已不是待发布态）。
export async function publishTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'pending',
            updated_at = now()
      WHERE id = $1 AND status IN ('draft', 'scheduled')
      RETURNING *`,
    [taskId]
  );
  return result.rows[0] ?? null;
}

// 调度器：把所有到点的定时任务（scheduled 且 scheduled_at <= now()）翻成 pending。
// 幂等（WHERE status='scheduled'），多次/并发触发安全；逐条落 scheduled_published 审计事件。
// 返回本次提升的任务条数。
export async function promoteDueScheduledTasks(client: pg.Pool | pg.PoolClient): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE tasks
        SET status = 'pending',
            updated_at = now()
      WHERE status = 'scheduled'
        AND scheduled_at IS NOT NULL
        AND scheduled_at <= now()
      RETURNING id`
  );
  for (const row of result.rows) {
    await addTaskEvent(client, row.id, null, "scheduled_published", "定时到点，自动进入待处理队列", {});
  }
  return result.rowCount ?? 0;
}

// 当前处于 scheduled（定时待发）的任务数，供总览「调度器」卡片展示待发队列深度。
export async function countScheduledTasks(client: pg.Pool | pg.PoolClient): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks WHERE status = 'scheduled'`
  );
  return result.rows[0]?.count ?? 0;
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

export type TaskPredecessor = { id: string; title: string; status: string };

// 单任务详情：复用 listRecentTasks 的 SELECT（带 project_name / depends_on / blocked），
// 加 WHERE id=$1，并解析前置任务标题/状态供详情页展示。任务不存在返回 null。
export async function getTaskWithDeps(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<{ task: Task; predecessors: TaskPredecessor[] } | null> {
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
      WHERE tasks.id = $1
      LIMIT 1`,
    [taskId]
  );
  const task = result.rows[0];
  if (!task) {
    return null;
  }

  const ids = task.depends_on ?? [];
  let predecessors: TaskPredecessor[] = [];
  if (ids.length > 0) {
    const pre = await client.query<TaskPredecessor>(
      `SELECT id, title, status FROM tasks WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    const byId = new Map(pre.rows.map((row) => [row.id, row]));
    // 保持 depends_on 原顺序；已删除的前置任务在结果中缺失，由调用方按 depends_on 长度差识别。
    predecessors = ids.map((id) => byId.get(id)).filter((row): row is TaskPredecessor => Boolean(row));
  }
  return { task, predecessors };
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

// 任务流列表固定按更新时间排序，方向由列表头切换（默认 desc）。
export type SortDir = "asc" | "desc";

export type ListTasksFilters = {
  status?: string[];
  // 合并状态（多选）：unknown / unmerged / merged，与状态筛选独立叠加。
  mergeStatus?: string[];
  projectId?: string | null;
  // 项目级隔离：非 admin 传入其可访问项目 id 集合，约束只返回范围内任务（空集合 → 无结果）。
  projectIds?: string[] | null;
  q?: string | null;
  dir?: SortDir;
  limit: number;
  offset: number;
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
  if (filters.mergeStatus && filters.mergeStatus.length > 0) {
    params.push(filters.mergeStatus);
    conditions.push(`tasks.merge_status = ANY($${params.length}::text[])`);
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
  // 排序固定按 updated_at，仅方向可变（白名单 asc/desc），避免把外部输入拼进 ORDER BY。
  const orderBy = `tasks.updated_at ${filters.dir === "asc" ? "ASC" : "DESC"}`;

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

// 本 worker 认领过的全部任务（join projects 取 project_name），按 updated_at 倒序。
// worker 桌面端 Agent-View 式任务面板用：本机视角，只看 claimed_by=本 worker 的任务
// （pending/scheduled/draft 等未认领任务 claimed_by 为 null，天然不在此列表）。
export async function listWorkerTasks(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  limit = 200
): Promise<Task[]> {
  const result = await client.query<Task>(
    `SELECT tasks.*, projects.name AS project_name
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
      WHERE tasks.claimed_by = $1
      ORDER BY tasks.updated_at DESC
      LIMIT $2`,
    [workerId, limit]
  );
  return result.rows;
}

export async function listWorkers(client: pg.Pool | pg.PoolClient): Promise<Worker[]> {
  const result = await client.query<Worker>(
    `SELECT workers.*,
            CASE WHEN last_seen_at > now() - interval '60 seconds' THEN 'online' ELSE 'offline' END AS status,
            (SELECT count(*)::int FROM tasks
              WHERE tasks.claimed_by = workers.id
                AND tasks.status IN ('claimed', 'running')) AS active_task_count
       FROM workers
      ORDER BY last_seen_at DESC`
  );
  return result.rows;
}

export async function registerWorker(client: pg.Pool | pg.PoolClient, input: WorkerRegistration): Promise<Worker> {
  // working_state 不在这里写：只靠 INSERT 的表默认值（新 worker = idle）落初值，
  // ON CONFLICT 刻意不更新它，使本地/远程切换过的工作态在重连/重启后保留。
  const result = await client.query<Worker>(
    `INSERT INTO workers (id, name, host_name, app_version, capabilities, metadata,
                          allow_remote_control, max_parallel, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'online', now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       host_name = EXCLUDED.host_name,
       app_version = EXCLUDED.app_version,
       capabilities = EXCLUDED.capabilities,
       metadata = EXCLUDED.metadata,
       allow_remote_control = EXCLUDED.allow_remote_control,
       max_parallel = EXCLUDED.max_parallel,
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
      input.metadata ?? {},
      input.allowRemoteControl ?? false,
      input.maxParallel ?? 1
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

// 周期性刷新 worker 的动态信息（claude 版本 / 订阅 / 用量）与客户端策略。
// 不动 working_state（由切换接口管）与 last_seen_at（由 heartbeat 管）。
export async function updateWorkerInfo(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  input: WorkerInfoUpdate
): Promise<void> {
  await client.query(
    `UPDATE workers
        SET claude_version = $2,
            subscription_type = $3,
            usage = $4,
            allow_remote_control = $5,
            max_parallel = $6,
            updated_at = now()
      WHERE id = $1`,
    [
      workerId,
      input.claudeVersion,
      input.subscriptionType,
      input.usage,
      input.allowRemoteControl,
      input.maxParallel
    ]
  );
}

// 切换工作态。viaRemote=true（web 远程）时加 allow_remote_control 门槛，
// 客户端不允许远程控制则 0 行更新，调用方据此回 403/blocked。返回是否更新成功。
export async function setWorkerWorkingState(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  state: "idle" | "working",
  opts: { viaRemote?: boolean } = {}
): Promise<boolean> {
  const result = await client.query(
    `UPDATE workers
        SET working_state = $2, updated_at = now()
      WHERE id = $1${opts.viaRemote ? " AND allow_remote_control = true" : ""}`,
    [workerId, state]
  );
  return (result.rowCount ?? 0) > 0;
}

// worker 每个 tick 读它决定是否领任务、并行上限多少。worker 不存在返回 null。
export async function getWorkerRuntime(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<{ working_state: "idle" | "working"; max_parallel: number } | null> {
  const result = await client.query<{ working_state: "idle" | "working"; max_parallel: number }>(
    `SELECT working_state, max_parallel FROM workers WHERE id = $1`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// worktree GC 用：该 worker 仍「持有工作树」的任务 id（非终态）。终态任务的残留工作树会被清掉。
export async function listActiveTaskIdsForWorker(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE claimed_by = $1
        AND status IN ('claimed', 'running', 'waiting', 'success', 'rejected')`,
    [workerId]
  );
  return result.rows.map((row) => row.id);
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

// worker 桌面端「关联项目」面板用:列出该 worker 当前所有项目关联(join 项目取展示信息)。
export async function listWorkerProjectLinks(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<WorkerProjectLinkView[]> {
  const result = await client.query<WorkerProjectLinkView>(
    `SELECT worker_project_links.project_id,
            worker_project_links.local_path,
            worker_project_links.enabled,
            projects.name AS project_name,
            projects.repo_url,
            projects.default_branch
       FROM worker_project_links
       JOIN projects ON projects.id = worker_project_links.project_id
      WHERE worker_project_links.worker_id = $1
      ORDER BY projects.name ASC`,
    [workerId]
  );
  return result.rows;
}

// worker 桌面端删除一条本地添加的项目关联。按 projectName|repoUrl 解析 project 后删除该 (worker, project, localPath) 行。
export async function removeWorkerProjectLink(
  client: pg.Pool | pg.PoolClient,
  input: ProjectLinkInput
): Promise<void> {
  const match = await client.query<{ id: string }>(
    `SELECT id FROM projects
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
    `DELETE FROM worker_project_links
      WHERE worker_id = $1 AND project_id = $2 AND local_path = $3`,
    [input.workerId, project.id, input.localPath]
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
          -- 注：旧的「同项目有等待中工作类任务则不领新任务」护栏已移除——它的存在理由是
          -- 旧串行模型下同项目共用一个工作树、新任务 git checkout 会清掉等待任务的未提交改动。
          -- 现在每个工作类任务用独立 git worktree 隔离（见 apps/worker/src/worktree.ts），
          -- 同项目可真并发，等待中任务的工作树独立持有改动、不被新任务触碰，故护栏不再需要。
          -- 前置依赖门控：任一前置任务未到达「已完成」终态则不可领取。已完成 = accepted
          -- （人工验收通过）或 merged（PR 已合并清理 / 直推已落地，工作已进目标分支）。
          AND NOT EXISTS (
            SELECT 1
              FROM task_dependencies dep
              JOIN tasks pre ON pre.id = dep.depends_on_task_id
             WHERE dep.task_id = tasks.id
               AND pre.status NOT IN ('accepted', 'merged')
          )
        ORDER BY tasks.created_at ASC
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
    // status <> 'cancelled' 守卫:取消在途任务时 runner 先把任务抢占为 cancelled 再杀 Claude 进程,
    // 进程被杀导致执行链 reject 走到这里的 markTaskFailed 不能把 cancelled 覆盖回 failed。现有调用点
    // 任务都处于 claimed/running/waiting,该守卫对正常失败路径零影响。
    `UPDATE tasks
        SET status = 'failed',
            finished_at = now(),
            error_message = $3,
            result = $4,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2 AND status <> 'cancelled'`,
    [taskId, workerId, errorMessage, resultPayload]
  );
  await addTaskEvent(client, taskId, workerId, "failed", errorMessage, resultPayload);
}

// Console 请求取消在途任务:仅 claimed/running/waiting 可取消,打 cancel_requested_at 时间戳供 Worker 扫描。
// 返回更新后的任务;非在途态(已终态/draft/pending 等)返回 null,Console 据此提示「不可取消」。
export async function requestTaskCancellation(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET cancel_requested_at = now(), updated_at = now()
      WHERE id = $1 AND status IN ('claimed', 'running', 'waiting')
      RETURNING *`,
    [taskId]
  );
  const task = result.rows[0];
  if (!task) {
    return null;
  }
  await addTaskEvent(client, taskId, task.claimed_by, "cancel_requested", "Cancellation requested by user", {});
  return task;
}

// Worker tick 扫描:该 worker 名下、仍在途、已被请求取消的任务 id。命中则 Worker 杀进程并翻 cancelled。
export async function listCancelRequestedTaskIds(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE claimed_by = $1
        AND cancel_requested_at IS NOT NULL
        AND status IN ('claimed', 'running', 'waiting')`,
    [workerId]
  );
  return result.rows.map((row) => row.id);
}

// Worker 取消落终态:仅在途态可翻为 cancelled(守卫防覆盖已成功完成的任务)。返回是否成功翻转。
export async function markTaskCancelled(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  workerId: string,
  resultPayload: Record<string, unknown>
): Promise<boolean> {
  const result = await client.query(
    `UPDATE tasks
        SET status = 'cancelled',
            finished_at = now(),
            result = $3,
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running', 'waiting')`,
    [taskId, workerId, resultPayload]
  );
  const cancelled = (result.rowCount ?? 0) > 0;
  if (cancelled) {
    await addTaskEvent(client, taskId, workerId, "cancelled", "Task cancelled by worker", resultPayload);
  }
  return cancelled;
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

/* ===== Console 侧定时合并检查（独立于上面的 Worker 清理流程）=====
 * 方案见 docs/spec/task-merge-status-check.md。Console 不持有本地工作树，只读 repo_url 远程判定
 * work_branch 是否已并入 target_branch；检测到合并把 success 工作任务自动转 accepted。
 */

// 候选附带项目 repo_url，供 Console 检测助手做 gh / git 远程判定。
export type MergeCheckCandidate = Task & { repo_url: string };

// Console 合并检查候选：success 待验收且有 work/target 分支的任务，按 merge_status_checked_at
// 轮转取最久未查的一个（NULL 优先）。只读，不翻状态——是否合并由检测助手判定后回写。
export async function claimNextMergeCheckCandidate(
  client: pg.Pool | pg.PoolClient
): Promise<MergeCheckCandidate | null> {
  const result = await client.query<MergeCheckCandidate>(
    `SELECT tasks.*, projects.repo_url
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
      WHERE tasks.status = 'success'
        AND tasks.work_branch <> ''
        AND tasks.target_branch <> ''
      ORDER BY tasks.merge_status_checked_at ASC NULLS FIRST
      LIMIT 1`
  );
  return result.rows[0] ?? null;
}

// 检测到已合并：仅 success 可自动验收，原子翻 accepted + merge_status=merged。返回 true 表示翻态成功。
export async function markTaskMergeAccepted(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<boolean> {
  const result = await client.query(
    `UPDATE tasks
        SET status = 'accepted',
            merge_status = 'merged',
            merge_status_checked_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'success'`,
    [taskId]
  );
  if ((result.rowCount ?? 0) === 0) {
    return false;
  }
  await addTaskEvent(client, taskId, null, "merge_accepted", "检测到开发分支已合并进目标分支，自动验收", {});
  return true;
}

// 检测未合并：仅打合并状态 + 轮转游标，不动 updated_at（避免每轮把 success 任务顶到列表排序顶部）。
export async function setTaskMergeUnmerged(client: pg.Pool | pg.PoolClient, taskId: string): Promise<void> {
  await client.query(
    `UPDATE tasks
        SET merge_status = 'unmerged',
            merge_status_checked_at = now()
      WHERE id = $1 AND status = 'success'`,
    [taskId]
  );
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

// 任务执行会话记录（Claude Code session transcript 全文）的同步落库。Worker 执行期间周期 + 终态调用，
// 1:1 侧表 upsert，避免大字段进 tasks.* 读路径。
export async function upsertTaskSession(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  jsonl: string
): Promise<void> {
  await client.query(
    `INSERT INTO task_sessions (task_id, jsonl, synced_at)
     VALUES ($1, $2, now())
     ON CONFLICT (task_id) DO UPDATE SET jsonl = EXCLUDED.jsonl, synced_at = now()`,
    [taskId, jsonl]
  );
}

// 读取任务的会话 transcript（供 Console 渲染）。无则返回 null。
export async function getTaskSession(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<{ jsonl: string; synced_at: string } | null> {
  const result = await client.query<{ jsonl: string; synced_at: string }>(
    `SELECT jsonl, synced_at FROM task_sessions WHERE task_id = $1 LIMIT 1`,
    [taskId]
  );
  return result.rows[0] ?? null;
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

/* ============================== 实时直连对话（Worker Direct Chat） ==============================
 * 独立于任务流的问答通道：指定项目(分支) + 指定 worker，多轮对话；助手回复流式落 chunks（SSE 打字机）。
 * 派发照搬 direct_commands 的「按 worker_id 领专属队列」。详见 docs/spec/worker-direct-chat.md
 */

export async function createConversation(
  client: pg.Pool | pg.PoolClient,
  input: {
    projectId: string;
    workerId: string;
    branch: string;
    model: TaskModel;
    title?: string;
    createdBy: string | null;
  }
): Promise<Conversation> {
  const result = await client.query<Conversation>(
    `INSERT INTO conversations (project_id, worker_id, branch, model, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.projectId, input.workerId, input.branch, input.model, input.title ?? "", input.createdBy]
  );
  return result.rows[0]!;
}

// 列会话：join 项目 / worker 名 + 最后消息时间。projectIds 非 null 时按项目白名单过滤（RBAC）。
export async function listConversations(
  client: pg.Pool | pg.PoolClient,
  options: { projectIds: string[] | null; limit?: number } = { projectIds: null }
): Promise<Conversation[]> {
  const result = await client.query<Conversation>(
    `SELECT conversations.*,
            projects.name AS project_name,
            workers.name AS worker_name,
            (SELECT max(created_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id) AS last_message_at,
            EXISTS (SELECT 1 FROM conversation_messages g
                     WHERE g.conversation_id = conversations.id
                       AND g.role = 'assistant' AND g.status IN ('pending', 'streaming')) AS generating
       FROM conversations
       JOIN projects ON projects.id = conversations.project_id
       JOIN workers ON workers.id = conversations.worker_id
      WHERE ($1::uuid[] IS NULL OR conversations.project_id = ANY($1))
      ORDER BY conversations.updated_at DESC
      LIMIT $2`,
    [options.projectIds, options.limit ?? 100]
  );
  return result.rows;
}

// 列某 worker 的全部会话（含派生 generating / last_message_at），供桌面端「对话」面板按状态分组展示。
// 远程 web 对话实际跑在该 worker，桌面端据此回显对话进度。
export async function listWorkerConversations(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  limit = 100
): Promise<Conversation[]> {
  const result = await client.query<Conversation>(
    `SELECT conversations.*,
            projects.name AS project_name,
            workers.name AS worker_name,
            (SELECT max(created_at) FROM conversation_messages m WHERE m.conversation_id = conversations.id) AS last_message_at,
            EXISTS (SELECT 1 FROM conversation_messages g
                     WHERE g.conversation_id = conversations.id
                       AND g.role = 'assistant' AND g.status IN ('pending', 'streaming')) AS generating
       FROM conversations
       JOIN projects ON projects.id = conversations.project_id
       JOIN workers ON workers.id = conversations.worker_id
      WHERE conversations.worker_id = $1
      ORDER BY conversations.updated_at DESC
      LIMIT $2`,
    [workerId, limit]
  );
  return result.rows;
}

export async function getConversation(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<Conversation | null> {
  const result = await client.query<Conversation>(
    `SELECT conversations.*,
            projects.name AS project_name,
            workers.name AS worker_name
       FROM conversations
       JOIN projects ON projects.id = conversations.project_id
       JOIN workers ON workers.id = conversations.worker_id
      WHERE conversations.id = $1`,
    [conversationId]
  );
  return result.rows[0] ?? null;
}

export async function listConversationMessages(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<ConversationMessage[]> {
  const result = await client.query<ConversationMessage>(
    `SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq ASC`,
    [conversationId]
  );
  return result.rows;
}

// 追加一条消息（用户提问用 role='user'）。seq = 当前会话最大 seq + 1，并 bump 会话 updated_at。
export async function addConversationMessage(
  client: pg.Pool | pg.PoolClient,
  input: { conversationId: string; role: ConversationMessageRole; body: string }
): Promise<ConversationMessage> {
  const result = await client.query<ConversationMessage>(
    `INSERT INTO conversation_messages (conversation_id, seq, role, body, status)
     SELECT $1,
            COALESCE((SELECT max(seq) FROM conversation_messages WHERE conversation_id = $1), -1) + 1,
            $2, $3, 'done'
     RETURNING *`,
    [input.conversationId, input.role, input.body]
  );
  await client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [input.conversationId]);
  return result.rows[0]!;
}

// Worker 领下一个待应答的对话轮：本 worker 的 active 会话、最后一条是 user 消息、且无在途 assistant 轮。
// 认领动作 = 原子插入一条 assistant 'streaming' 消息（FOR UPDATE SKIP LOCKED 防并发重复应答）。
export async function claimNextConversationTurn(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<ConversationMessage | null> {
  const result = await client.query<ConversationMessage>(
    `WITH candidate AS (
       SELECT c.id AS conversation_id,
              COALESCE((SELECT max(m.seq) FROM conversation_messages m WHERE m.conversation_id = c.id), -1) + 1 AS next_seq
         FROM conversations c
        WHERE c.worker_id = $1
          AND c.status = 'active'
          AND (SELECT m.role FROM conversation_messages m
                WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM conversation_messages m
             WHERE m.conversation_id = c.id
               AND m.role = 'assistant'
               AND m.status IN ('pending', 'streaming'))
        ORDER BY c.updated_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     INSERT INTO conversation_messages (conversation_id, seq, role, body, status, claimed_by)
     SELECT conversation_id, next_seq, 'assistant', '', 'streaming', $1 FROM candidate
     RETURNING *`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// 本轮提问：取「最后一条已完成 assistant 之后」的所有 user 消息，按 seq 拼接（多条连发合并为一轮）。
export async function getConversationPrompt(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<string | null> {
  const result = await client.query<{ prompt: string | null }>(
    `SELECT string_agg(body, E'\n\n' ORDER BY seq) AS prompt
       FROM conversation_messages
      WHERE conversation_id = $1
        AND role = 'user'
        AND seq > COALESCE(
          (SELECT max(seq) FROM conversation_messages
            WHERE conversation_id = $1 AND role = 'assistant' AND status IN ('done', 'failed')),
          -1)`,
    [conversationId]
  );
  return result.rows[0]?.prompt ?? null;
}

// 建对话前校验：该 worker 是否关联了此项目（否则它无 localPath、永远领不到该对话轮）。
export async function workerLinkedToProject(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  projectId: string
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM worker_project_links WHERE worker_id = $1 AND project_id = $2 AND enabled = true LIMIT 1`,
    [workerId, projectId]
  );
  return (result.rowCount ?? 0) > 0;
}

// Worker 解析 conversation 的项目本地检出路径（经 worker_project_links）。
export async function getConversationLocalPath(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  workerId: string
): Promise<string | null> {
  const result = await client.query<{ local_path: string }>(
    `SELECT worker_project_links.local_path
       FROM conversations
       JOIN worker_project_links ON worker_project_links.project_id = conversations.project_id
      WHERE conversations.id = $1
        AND worker_project_links.worker_id = $2
        AND worker_project_links.enabled = true
      LIMIT 1`,
    [conversationId, workerId]
  );
  return result.rows[0]?.local_path ?? null;
}

// 对话执行会话记录（Claude Code session transcript 全文）的同步落库。Worker 执行对话轮时周期 + 终态调用，
// 与任务 task_sessions 同构：1:1 侧表 upsert，避免大字段进 conversations.* 读路径。
export async function upsertConversationSession(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  jsonl: string
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_sessions (conversation_id, jsonl, synced_at)
     VALUES ($1, $2, now())
     ON CONFLICT (conversation_id) DO UPDATE SET jsonl = EXCLUDED.jsonl, synced_at = now()`,
    [conversationId, jsonl]
  );
}

// 读取对话的会话 transcript（供 Console 富展示）。无则返回 null。
export async function getConversationSession(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<{ jsonl: string; synced_at: string } | null> {
  const result = await client.query<{ jsonl: string; synced_at: string }>(
    `SELECT jsonl, synced_at FROM conversation_sessions WHERE conversation_id = $1 LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] ?? null;
}

// 流式收尾：落最终全文 + done；首轮把 claude session 写回会话（COALESCE 不覆盖已有）。
export async function finalizeConversationTurn(
  client: pg.Pool | pg.PoolClient,
  input: { conversationId: string; messageId: string; body: string; sessionId: string | null }
): Promise<void> {
  await client.query(
    `UPDATE conversation_messages
        SET body = $2, status = 'done', updated_at = now()
      WHERE id = $1`,
    [input.messageId, input.body]
  );
  await client.query(
    `UPDATE conversations
        SET claude_session_id = COALESCE($2, claude_session_id), updated_at = now()
      WHERE id = $1`,
    [input.conversationId, input.sessionId]
  );
}

export async function failConversationTurn(
  client: pg.Pool | pg.PoolClient,
  input: { messageId: string; errorMessage: string }
): Promise<void> {
  await client.query(
    `UPDATE conversation_messages
        SET status = 'failed', error_message = $2, updated_at = now()
      WHERE id = $1`,
    [input.messageId, input.errorMessage]
  );
}

export async function closeConversation(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<void> {
  await client.query(
    `UPDATE conversations SET status = 'closed', updated_at = now() WHERE id = $1`,
    [conversationId]
  );
}

// 重命名会话：仅改标题（不 bump updated_at，避免改名打乱列表按活跃排序）。
export async function renameConversation(
  client: pg.Pool | pg.PoolClient,
  conversationId: string,
  title: string
): Promise<void> {
  await client.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [conversationId, title]);
}

// 删除会话：消息(conversation_messages)、session jsonl(conversation_sessions) 经外键 ON DELETE CASCADE 一并清除。
export async function deleteConversation(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<boolean> {
  const r = await client.query(`DELETE FROM conversations WHERE id = $1`, [conversationId]);
  return (r.rowCount ?? 0) > 0;
}
