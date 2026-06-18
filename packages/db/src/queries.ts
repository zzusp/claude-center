import type pg from "pg";
import {
  ACTIVE_WORKER_STATUSES,
  COMPLETED_STATUSES,
  IN_FLIGHT_STATUSES,
  PUBLISHABLE_STATUSES,
  REACTIVATABLE_STATUSES,
  RETRYABLE_STATUSES,
  sqlInList
} from "./task-state.js";
import type {
  Attachment,
  AttachmentKind,
  AttachmentMeta,
  Conversation,
  ConversationMessage,
  ConversationMessageRole,
  DirectCommand,
  DirectCommandName,
  Notification,
  NotificationType,
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
  ProjectRepo,
  ProjectRepoRole,
  TaskRepo,
  TaskRepoSubStatus,
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
  // 桌面端运行终端配置，随 register 上报一次，变动时经 updateWorkerTerminal 刷新。
  terminalCommand?: string;
  claudePreCommand?: string;
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
  const project = result.rows[0]!;
  // 多仓任务支持：项目建立时同时落 project_repos 主仓行（'.'），与 projects 保持一致。
  await syncMainProjectRepo(client, project.id);
  return project;
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
  const project = result.rows[0] ?? null;
  if (project) {
    // 多仓任务支持：项目元信息（repo_url / default_branch / name）变更后同步主仓行。
    await syncMainProjectRepo(client, project.id);
  }
  return project;
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
    // 自动回复（兜底）：见 Task.auto_reply 注释。
    autoReply: boolean;
    // 决策预案：auto_reply=true 时拼进 prompt（不勾自动回复则传空串）。
    autoDecisionHints: string;
    // 任务级 Claude 执行模型；'default' 表示 Worker 执行时不传 --model。
    model: TaskModel;
    // 指定发布时间则落 'scheduled' 定时态，到点由调度器转 pending；为空走默认 'draft'。
    scheduledAt?: string | null;
  }
): Promise<Task> {
  const scheduledAt = input.scheduledAt ?? null;
  const status = scheduledAt ? "scheduled" : "draft";
  const result = await client.query<Task>(
    `INSERT INTO tasks (project_id, title, description, base_branch, work_branch, target_branch, submit_mode, model, auto_merge_pr, auto_reply, auto_decision_hints, status, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      input.autoReply,
      input.autoDecisionHints,
      status,
      scheduledAt
    ]
  );
  return result.rows[0]!;
}

// 编辑任务：仅限 draft / scheduled 态（未开始执行），可改标题/描述/分支/提交模式等。
// scheduledAt 非空则维持 scheduled 态，否则切回 draft。返回 null 表示任务不存在或已不可编辑。
export async function updateTask(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  input: {
    title: string;
    description: string;
    baseBranch: string;
    workBranch: string;
    targetBranch: string;
    submitMode: TaskSubmitMode;
    autoMergePr: boolean;
    autoReply: boolean;
    autoDecisionHints: string;
    model: TaskModel;
    scheduledAt?: string | null;
  }
): Promise<Task | null> {
  const scheduledAt = input.scheduledAt ?? null;
  const status = scheduledAt ? "scheduled" : "draft";
  const result = await client.query<Task>(
    `UPDATE tasks
        SET title = $2,
            description = $3,
            base_branch = $4,
            work_branch = $5,
            target_branch = $6,
            submit_mode = $7,
            auto_merge_pr = $8,
            auto_reply = $9,
            auto_decision_hints = $10,
            model = $11,
            scheduled_at = $12,
            status = $13,
            updated_at = now()
      WHERE id = $1 AND status IN (${sqlInList(PUBLISHABLE_STATUSES)})
      RETURNING *`,
    [
      taskId,
      input.title,
      input.description,
      input.baseBranch,
      input.workBranch,
      input.targetBranch,
      input.submitMode,
      input.autoMergePr,
      input.autoReply,
      input.autoDecisionHints,
      input.model,
      scheduledAt,
      status
    ]
  );
  return result.rows[0] ?? null;
}

// 删除任务：仅「已认领 / 执行中」（claimed / running）在途态禁止删除，其余状态均可删除。
// 返回 false 表示任务不存在或正处于在途态不可删除。
export async function deleteTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<boolean> {
  const result = await client.query(
    `DELETE FROM tasks WHERE id = $1 AND status NOT IN (${sqlInList(ACTIVE_WORKER_STATUSES)})`,
    [taskId]
  );
  return (result.rowCount ?? 0) > 0;
}

// 重新激活失败/已取消的任务：failed / cancelled → draft（草稿），清空执行现场（时间戳/错误/PR 等）
// 与定时设置，退回草稿后由用户确认/编辑再手动发布。返回 null 表示任务不存在或状态不满足。
export async function reactivateTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'draft',
            scheduled_at = null,
            claimed_by = null,
            claimed_at = null,
            started_at = null,
            finished_at = null,
            error_message = null,
            result = '{}',
            pr_url = null,
            merge_status = 'unknown',
            merge_status_checked_at = null,
            merge_checked_at = null,
            claude_session_id = null,
            cancel_requested_at = null,
            retry_requested_at = null,
            updated_at = now()
      WHERE id = $1 AND status IN (${sqlInList(REACTIVATABLE_STATUSES)})
      RETURNING *`,
    [taskId]
  );
  return result.rows[0] ?? null;
}

// 发布任务：draft / scheduled → pending，进入可认领队列。对 scheduled 任务即「立即发布」
// （到点前手动提前发布，覆盖定时）。WHERE 限定初始态保证对已认领/运行中/已完成任务无副作用；
// 未命中返回 null（任务不存在或已不是待发布态）。
export async function publishTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'pending',
            updated_at = now()
      WHERE id = $1 AND status IN (${sqlInList(PUBLISHABLE_STATUSES)})
      RETURNING *`,
    [taskId]
  );
  const task = result.rows[0];
  if (!task) {
    return null;
  }
  await addTaskEvent(client, taskId, null, "published", "发布，进入待处理队列", {});
  return task;
}

// 退回草稿：pending → draft（撤回尚未被认领的待处理任务）。仅 pending 态命中，清空定时设置
// 回到纯草稿，由用户确认/编辑后重新发布。返回 null 表示任务不存在或已不是待处理态。
export async function unpublishTask(client: pg.Pool | pg.PoolClient, taskId: string): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET status = 'draft',
            scheduled_at = null,
            updated_at = now()
      WHERE id = $1 AND status = 'pending'
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
            workers.name AS worker_name,
            COALESCE(dep.depends_on, ARRAY[]::uuid[]) AS depends_on,
            COALESCE(dep.blocked, false) AS blocked
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       LEFT JOIN workers ON workers.id = tasks.claimed_by
       LEFT JOIN LATERAL (
         SELECT array_agg(d.depends_on_task_id) AS depends_on,
                bool_or(pre.status NOT IN (${sqlInList(COMPLETED_STATUSES)})) AS blocked
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
            workers.name AS worker_name,
            COALESCE(dep.depends_on, ARRAY[]::uuid[]) AS depends_on,
            COALESCE(dep.blocked, false) AS blocked
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       LEFT JOIN workers ON workers.id = tasks.claimed_by
       LEFT JOIN LATERAL (
         SELECT array_agg(d.depends_on_task_id) AS depends_on,
                bool_or(pre.status NOT IN (${sqlInList(COMPLETED_STATUSES)})) AS blocked
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
  task.attachments = await listAttachmentsForTask(client, task.id);
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
  // 已认领 worker id 过滤；右栏「Worker」下拉用。空/未传 = 不过滤。
  workerId?: string | null;
  // 提交模式过滤(pr / push):任务调度列表筛选「提交模式」用。空/未传 = 不过滤。
  submitMode?: TaskSubmitMode | null;
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
  if (filters.workerId) {
    params.push(filters.workerId);
    conditions.push(`tasks.claimed_by = $${params.length}`);
  }
  if (filters.submitMode) {
    params.push(filters.submitMode);
    conditions.push(`tasks.submit_mode = $${params.length}`);
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
  // 排序固定按 created_at，仅方向可变（白名单 asc/desc），避免把外部输入拼进 ORDER BY。
  const orderBy = `tasks.created_at ${filters.dir === "asc" ? "ASC" : "DESC"}`;

  params.push(filters.limit);
  const limitIdx = params.length;
  params.push(filters.offset);
  const offsetIdx = params.length;

  const result = await client.query<Task & { total_count: string }>(
    `SELECT tasks.*,
            projects.name AS project_name,
            workers.name AS worker_name,
            count(*) OVER() AS total_count
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       LEFT JOIN workers ON workers.id = tasks.claimed_by
       ${where}
      ORDER BY ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  const total = result.rows[0] ? Number(result.rows[0].total_count) : 0;
  const tasks = result.rows.map(({ total_count: _total, ...task }) => task as Task);
  return { tasks, total };
}

// 任务流右侧栏统计：总计 + 按状态计数 + 按项目计数 + 今日创建/完成率/平均耗时。
// 终态以 finished_at 落在 [todayStartIso, now) 为窗（避免时区偏移影响）；今日创建以 created_at 同窗；
// 调用方传入本地 0 点 ISO。非 admin 只看其有项目权限的任务（JOIN user_project_links 过滤）。
export type TaskStatsResult = {
  total: number;
  byStatus: Record<string, number>;
  byProject: { id: string; name: string; n: number }[];
  today: {
    created: number;
    finished: number;
    // 「完成」= 进入 success / merged 终态;「失败」= failed / cancelled。
    completed: number;
    failed: number;
    avgDurationMs: number | null;
  };
};

export async function listTaskStatsForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role },
  todayStartIso: string
): Promise<TaskStatsResult> {
  const isAdmin = user.role === "admin";
  // 项目范围约束：admin 全开放；其余 JOIN user_project_links 过滤。
  const scopeJoin = isAdmin
    ? ""
    : "JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2";
  const params: unknown[] = [todayStartIso];
  if (!isAdmin) params.push(user.id);

  const sql = `
    WITH scoped AS (
      SELECT tasks.id,
             tasks.status,
             tasks.project_id,
             projects.name AS project_name,
             tasks.created_at,
             tasks.started_at,
             tasks.finished_at
        FROM tasks
        JOIN projects ON projects.id = tasks.project_id
        ${scopeJoin}
    ),
    by_status AS (
      SELECT status, count(*)::int AS n FROM scoped GROUP BY status
    ),
    by_project AS (
      SELECT project_id, project_name, count(*)::int AS n
        FROM scoped
       GROUP BY project_id, project_name
       ORDER BY n DESC, project_name ASC
    ),
    today_window AS (
      SELECT
        (SELECT count(*) FROM scoped WHERE created_at >= $1::timestamptz)::int AS created,
        count(*) FILTER (WHERE finished_at >= $1::timestamptz AND status IN ('success','merged','failed','cancelled'))::int AS finished,
        count(*) FILTER (WHERE finished_at >= $1::timestamptz AND status IN ('success','merged'))::int AS completed,
        count(*) FILTER (WHERE finished_at >= $1::timestamptz AND status IN ('failed','cancelled'))::int AS failed,
        avg(EXTRACT(EPOCH FROM (finished_at - started_at))) FILTER (
          WHERE finished_at >= $1::timestamptz
            AND finished_at IS NOT NULL
            AND started_at IS NOT NULL
            AND status IN ('success','merged','failed','cancelled')
        ) AS avg_secs
      FROM scoped
    )
    SELECT
      (SELECT count(*)::int FROM scoped) AS total,
      (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM by_status) AS by_status,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', project_id, 'name', project_name, 'n', n)), '[]'::jsonb) FROM by_project) AS by_project,
      (SELECT created FROM today_window) AS today_created,
      (SELECT finished FROM today_window) AS today_finished,
      (SELECT completed FROM today_window) AS today_completed,
      (SELECT failed FROM today_window) AS today_failed,
      (SELECT avg_secs FROM today_window) AS today_avg_secs
  `;

  const result = await client.query<{
    total: number;
    by_status: Record<string, number>;
    by_project: { id: string; name: string; n: number }[];
    today_created: number | null;
    today_finished: number | null;
    today_completed: number | null;
    today_failed: number | null;
    today_avg_secs: string | number | null;
  }>(sql, params);
  const row = result.rows[0];
  const avgSecs = row?.today_avg_secs == null ? null : Number(row.today_avg_secs);
  return {
    total: row?.total ?? 0,
    byStatus: row?.by_status ?? {},
    byProject: row?.by_project ?? [],
    today: {
      created: row?.today_created ?? 0,
      finished: row?.today_finished ?? 0,
      completed: row?.today_completed ?? 0,
      failed: row?.today_failed ?? 0,
      avgDurationMs: avgSecs == null || Number.isNaN(avgSecs) ? null : Math.round(avgSecs * 1000)
    }
  };
}

// 总览卡「今日新任务」与 7 天 sparkline：用 todayStartIso 反推 7 个 [start, start+1d) 桶，
// 每桶 count 一次，缺失自然落 0。返回 number[]，长度 7，下标 0 = 6 天前，下标 6 = 今天。
// RBAC 与 listTaskStatsForUser 一致：admin 全开；非 admin JOIN user_project_links 过滤。
export async function listTaskCreationLast7ForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role },
  todayStartIso: string
): Promise<number[]> {
  const isAdmin = user.role === "admin";
  const scopeJoin = isAdmin
    ? ""
    : "JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2";
  const params: unknown[] = [todayStartIso];
  if (!isAdmin) params.push(user.id);

  const result = await client.query<{ cnt: number }>(
    `SELECT (
       SELECT count(*)::int
         FROM tasks ${scopeJoin}
        WHERE tasks.created_at >= gs
          AND tasks.created_at < gs + interval '1 day'
     ) AS cnt
       FROM generate_series(
         $1::timestamptz - interval '6 days',
         $1::timestamptz,
         interval '1 day'
       ) AS gs
      ORDER BY gs`,
    params
  );
  return result.rows.map((row) => row.cnt);
}

// 总览卡「今日完成」7 天 sparkline：按 finished_at 切 7 桶，status IN ('success','merged') 视为完成。
// 注意：tasks 没有独立 merged_at 字段，success → merged 状态翻转不重置 finished_at，所以
// merged 任务的 finished_at = 首次进 success 的时刻；这里口径是「当日进入 success 且现在已合并」也算。
// RBAC 与 listTaskCreationLast7ForUser 一致。
export async function listTaskCompletionLast7ForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role },
  todayStartIso: string
): Promise<number[]> {
  const isAdmin = user.role === "admin";
  const scopeJoin = isAdmin
    ? ""
    : "JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2";
  const params: unknown[] = [todayStartIso];
  if (!isAdmin) params.push(user.id);

  const result = await client.query<{ cnt: number }>(
    `SELECT (
       SELECT count(*)::int
         FROM tasks ${scopeJoin}
        WHERE tasks.finished_at >= gs
          AND tasks.finished_at < gs + interval '1 day'
          AND tasks.status IN ('success', 'merged')
     ) AS cnt
       FROM generate_series(
         $1::timestamptz - interval '6 days',
         $1::timestamptz,
         interval '1 day'
       ) AS gs
      ORDER BY gs`,
    params
  );
  return result.rows.map((row) => row.cnt);
}

// 总览卡「今日合并」7 天 sparkline：按 finished_at 切 7 桶，status='merged' 视为合并。
// 同上：finished_at 实际是首次完成时刻；语义为「当日完成的任务中现处于 merged 状态的数量」，
// 不等于「当日 PR 被 merge 的数量」（需独立 merged_at 字段，未来若需可加 migration）。
export async function listTaskMergedLast7ForUser(
  client: pg.Pool | pg.PoolClient,
  user: { id: string; role: Role },
  todayStartIso: string
): Promise<number[]> {
  const isAdmin = user.role === "admin";
  const scopeJoin = isAdmin
    ? ""
    : "JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2";
  const params: unknown[] = [todayStartIso];
  if (!isAdmin) params.push(user.id);

  const result = await client.query<{ cnt: number }>(
    `SELECT (
       SELECT count(*)::int
         FROM tasks ${scopeJoin}
        WHERE tasks.finished_at >= gs
          AND tasks.finished_at < gs + interval '1 day'
          AND tasks.status = 'merged'
     ) AS cnt
       FROM generate_series(
         $1::timestamptz - interval '6 days',
         $1::timestamptz,
         interval '1 day'
       ) AS gs
      ORDER BY gs`,
    params
  );
  return result.rows.map((row) => row.cnt);
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
            COALESCE(act.active_task_count, 0) AS active_task_count,
            COALESCE(done.completed_task_count, 0) AS completed_task_count
       FROM workers
       LEFT JOIN (
         SELECT claimed_by, count(*)::int AS active_task_count
           FROM tasks
          WHERE status IN (${sqlInList(ACTIVE_WORKER_STATUSES)})
          GROUP BY claimed_by
       ) act ON act.claimed_by = workers.id
       LEFT JOIN (
         SELECT claimed_by, count(*)::int AS completed_task_count
           FROM tasks
          WHERE status IN (${sqlInList(COMPLETED_STATUSES)})
          GROUP BY claimed_by
       ) done ON done.claimed_by = workers.id
      ORDER BY last_seen_at DESC`
  );
  return result.rows;
}

export async function registerWorker(client: pg.Pool | pg.PoolClient, input: WorkerRegistration): Promise<Worker> {
  // 通知判定：worker 首次注册或之前是 offline → online 翻转时落 worker_online 通知。
  // 先看上一轮 last_seen_at 是否在 60s 内，再 upsert；窄查询无开销。
  const prev = await client.query<{ last_seen_at: Date | null }>(
    `SELECT last_seen_at FROM workers WHERE id = $1 LIMIT 1`,
    [input.id]
  );
  const wasOnline = prev.rows[0]
    ? prev.rows[0].last_seen_at !== null && Date.now() - new Date(prev.rows[0].last_seen_at).getTime() < 60_000
    : false;
  const isFirstSeen = prev.rows.length === 0;

  // working_state 不在这里写：只靠 INSERT 的表默认值（新 worker = idle）落初值，
  // ON CONFLICT 刻意不更新它，使本地/远程切换过的工作态在重连/重启后保留。
  const result = await client.query<Worker>(
    `INSERT INTO workers (id, name, host_name, app_version, capabilities, metadata,
                          allow_remote_control, max_parallel, terminal_command, claude_pre_command,
                          status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'online', now())
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       host_name = EXCLUDED.host_name,
       app_version = EXCLUDED.app_version,
       capabilities = EXCLUDED.capabilities,
       metadata = EXCLUDED.metadata,
       allow_remote_control = EXCLUDED.allow_remote_control,
       max_parallel = EXCLUDED.max_parallel,
       terminal_command = EXCLUDED.terminal_command,
       claude_pre_command = EXCLUDED.claude_pre_command,
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
      input.maxParallel ?? 1,
      input.terminalCommand ?? "",
      input.claudePreCommand ?? ""
    ]
  );
  const worker = result.rows[0]!;
  // offline→online 翻转或首次注册时给全部 admin 发一条上线通知。
  // 单纯心跳保持在线（仍 online）不触发——避免每分钟一条。
  if (isFirstSeen || !wasOnline) {
    const displayName = worker.label || worker.name || worker.id.slice(0, 8);
    await emitWorkerNotification(client, {
      type: "worker_online",
      workerId: worker.id,
      title: isFirstSeen
        ? `Worker「${displayName}」首次上线`
        : `Worker「${displayName}」已重新上线`,
      body: `主机：${worker.host_name}，版本：${worker.app_version}`
    });
  }
  return worker;
}

export async function heartbeatWorker(client: pg.Pool | pg.PoolClient, workerId: string): Promise<void> {
  await client.query(
    `UPDATE workers
        SET status = 'online', last_seen_at = now(), updated_at = now()
      WHERE id = $1`,
    [workerId]
  );
}

// Console 后台轮询用：把 status='online' 但 last_seen_at 已超过 60s 的 worker 翻为 offline 并发通知。
// 用 status 字段做幂等门——同一 worker 仅在首次 stale 时翻一次，重启上线后由 registerWorker 翻回 online。
// 返回本轮翻态的 worker 数量供日志。
export async function sweepStaleWorkers(client: pg.Pool | pg.PoolClient): Promise<number> {
  const result = await client.query<{ id: string; name: string; label: string | null; host_name: string }>(
    `UPDATE workers
        SET status = 'offline', updated_at = now()
      WHERE status = 'online'
        AND last_seen_at < now() - interval '60 seconds'
      RETURNING id, name, label, host_name`
  );
  for (const row of result.rows) {
    const displayName = row.label || row.name || row.id.slice(0, 8);
    await emitWorkerNotification(client, {
      type: "worker_offline",
      workerId: row.id,
      title: `Worker「${displayName}」已离线`,
      body: `心跳超过 60 秒未更新，主机：${row.host_name}`
    });
  }
  return result.rowCount ?? 0;
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

// 更新 worker 运行终端配置（桌面端 setTerminalCommand/setPreCommand 时调用）。
export async function updateWorkerTerminal(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  terminalCommand: string,
  claudePreCommand: string
): Promise<void> {
  await client.query(
    `UPDATE workers
        SET terminal_command = $2, claude_pre_command = $3, updated_at = now()
      WHERE id = $1`,
    [workerId, terminalCommand, claudePreCommand]
  );
}

// web 端重命名：仅更新 label 字段（null=清除自定义名，显示回 name）。
// worker 重注册不覆盖 label，所以此操作跨重启生效。
export async function updateWorkerLabel(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  label: string | null
): Promise<boolean> {
  const result = await client.query(
    `UPDATE workers SET label = $2, updated_at = now() WHERE id = $1`,
    [workerId, label || null]
  );
  return (result.rowCount ?? 0) > 0;
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

// 单个 worker 详情（含派生字段），供 web 详情页轮询。不存在返回 null。
export async function getWorker(client: pg.Pool | pg.PoolClient, workerId: string): Promise<Worker | null> {
  const result = await client.query<Worker>(
    `SELECT workers.*,
            CASE WHEN last_seen_at > now() - interval '60 seconds' THEN 'online' ELSE 'offline' END AS status,
            (SELECT count(*)::int FROM tasks
              WHERE tasks.claimed_by = workers.id
                AND tasks.status IN (${sqlInList(ACTIVE_WORKER_STATUSES)})) AS active_task_count
       FROM workers
      WHERE workers.id = $1`,
    [workerId]
  );
  return result.rows[0] ?? null;
}

// 删除 worker 记录。返回是否存在并删除成功。
export async function deleteWorker(client: pg.Pool | pg.PoolClient, workerId: string): Promise<boolean> {
  const result = await client.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
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
  // 保留工作树的状态:在途(claimed/running/waiting)、Worker 已交付(success)、已合并(merged),
  // 以及可续接重试的 failed/cancelled——保留 success/merged 是因为「不再清理 worktree」(取消人工验收后,
  // 用户仍可用本地 worktree 继续手工排查/复用)；保留 failed/cancelled 是为了「重试」精确恢复未提交改动
  // (见 docs/spec/task-event-timeline-retry.md §4.3)。draft 不在此列,树由 GC 回收。
  const result = await client.query<{ id: string }>(
    `SELECT id FROM tasks
      WHERE claimed_by = $1
        AND status IN ('claimed', 'running', 'waiting', 'success', 'merged', 'failed', 'cancelled')`,
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
          -- 前置依赖门控：任一前置任务未到达「已完成」终态则不可领取。已完成 = success
          -- （Worker 已交付:PR 模式建好 PR / push 模式直推已落地）或 merged（PR 已被检测到合并）。
          AND NOT EXISTS (
            SELECT 1
              FROM task_dependencies dep
              JOIN tasks pre ON pre.id = dep.depends_on_task_id
             WHERE dep.task_id = tasks.id
               AND pre.status NOT IN (${sqlInList(COMPLETED_STATUSES)})
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
  const task = result.rows[0];
  if (!task) {
    return null;
  }
  await addTaskEvent(client, task.id, workerId, "claimed", "Worker 认领任务", {});
  const workerName = await getWorkerDisplayName(client, workerId);
  await emitTaskNotification(client, {
    type: "task_claimed",
    taskId: task.id,
    projectId: task.project_id,
    title: `任务「${task.title}」已被领取`,
    body: `Worker ${workerName} 已认领该任务并开始执行。`
  });
  return task;
}

// 仅供通知 fanout 用：取 worker 的显示名（label 优先 / 否则 name；都没有用 id 末段兜底）。
async function getWorkerDisplayName(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<string> {
  const result = await client.query<{ label: string | null; name: string }>(
    `SELECT label, name FROM workers WHERE id = $1 LIMIT 1`,
    [workerId]
  );
  const row = result.rows[0];
  if (!row) return workerId.slice(0, 8);
  return row.label || row.name || workerId.slice(0, 8);
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
  const taskMeta = await getTaskMetaForNotify(client, taskId);
  if (taskMeta) {
    await emitTaskNotification(client, {
      type: "task_success",
      taskId,
      projectId: taskMeta.project_id,
      title: `任务「${taskMeta.title}」已完成`,
      body: prUrl ? `Worker 已交付，PR 已建：${prUrl}` : `Worker 已完成执行。`
    });
    if (prUrl) {
      await emitTaskNotification(client, {
        type: "task_pr_created",
        taskId,
        projectId: taskMeta.project_id,
        title: `任务「${taskMeta.title}」PR 已建`,
        body: prUrl,
        link: prUrl
      });
    }
  }
}

async function getTaskMetaForNotify(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<{ project_id: string; title: string } | null> {
  const result = await client.query<{ project_id: string; title: string }>(
    `SELECT project_id, title FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId]
  );
  return result.rows[0] ?? null;
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
  const taskMeta = await getTaskMetaForNotify(client, taskId);
  if (taskMeta) {
    await emitTaskNotification(client, {
      type: "task_failed",
      taskId,
      projectId: taskMeta.project_id,
      title: `任务「${taskMeta.title}」执行失败`,
      body: errorMessage || "Worker 报告执行失败。"
    });
  }
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
      WHERE id = $1 AND status IN (${sqlInList(IN_FLIGHT_STATUSES)})
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

// 用户请求续接重试:仅 failed/cancelled 可重试,打 retry_requested_at 时间戳供 Worker 的
// claimNextRetryableTask 扫描续接。不直接翻 running(running 不在任何 claim 谓词里,Worker 不会捡)——
// 与打回链一致(Console 只置标记,Worker 再翻 running)。返回更新后的任务;非可重试态返回 null。
export async function requestTaskRetry(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `UPDATE tasks
        SET retry_requested_at = now(), updated_at = now()
      WHERE id = $1 AND status IN (${sqlInList(RETRYABLE_STATUSES)})
      RETURNING *`,
    [taskId]
  );
  const task = result.rows[0];
  if (!task) {
    return null;
  }
  await addTaskEvent(client, taskId, null, "retry_requested", "待 Worker 认领后续接执行", {});
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
        AND status IN (${sqlInList(IN_FLIGHT_STATUSES)})`,
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
      WHERE id = $1 AND claimed_by = $2 AND status IN (${sqlInList(IN_FLIGHT_STATUSES)})`,
    [taskId, workerId, resultPayload]
  );
  const cancelled = (result.rowCount ?? 0) > 0;
  if (cancelled) {
    await addTaskEvent(client, taskId, workerId, "cancelled", "Task cancelled by worker", resultPayload);
  }
  return cancelled;
}

/* ===== Console 侧定时合并检查 =====
 * 方案见 docs/spec/task-merge-status-check.md。取消「人工验收」后,「PR 已合并」是 success → merged 的
 * 唯一通路:Console 每 30s 轮询所有 success 且有 PR 的任务,远程判定 PR 是否已合并;合并即翻 merged
 * (终态),不再清理 worktree(用户仍可在本地复用)。没有 PR 的 success 是终态,不参与本检查。
 */

// 候选附带项目 repo_url,供 Console 检测助手做 gh / git 远程判定。
export type MergeCheckCandidate = Task & { repo_url: string };

// Console 合并检查候选:success 且有 PR 的任务,按 merge_status_checked_at 轮转取最久未查的一个
// (NULL 优先)。只读,不翻状态——是否合并由检测助手判定后回写。无 PR 的 success 不参与(终态)。
export async function claimNextMergeCheckCandidate(
  client: pg.Pool | pg.PoolClient
): Promise<MergeCheckCandidate | null> {
  const result = await client.query<MergeCheckCandidate>(
    `SELECT tasks.*, projects.repo_url
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
      WHERE tasks.status = 'success'
        AND tasks.pr_url IS NOT NULL
        AND tasks.work_branch <> ''
        AND tasks.target_branch <> ''
      ORDER BY tasks.merge_status_checked_at ASC NULLS FIRST
      LIMIT 1`
  );
  return result.rows[0] ?? null;
}

// 检测到 PR 已合并:仅 success 可翻 merged(终态),原子打 merge_status=merged。
// 不清理 worktree(取消人工验收后保留本地交付),不动 finished_at(沿用 success 时刻)。
// 返回 true 表示翻态成功。
export async function markTaskMerged(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<boolean> {
  const result = await client.query(
    `UPDATE tasks
        SET status = 'merged',
            merge_status = 'merged',
            merge_status_checked_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'success'`,
    [taskId]
  );
  if ((result.rowCount ?? 0) === 0) {
    return false;
  }
  await addTaskEvent(client, taskId, null, "merged", "检测到 PR 已合并，任务进入「已合并」终态", {});
  return true;
}

// 检测未合并:仅打合并状态 + 轮转游标,不动 updated_at(避免每轮把 success 任务顶到列表排序顶部)。
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
  // 待消费 user 评论的判定锚点：上一次 worker 真正消费用户回复的时刻——即最近一次 resumed /
  // rerun_started 事件时间，没有则 epoch。不再用「最后一条 worker 评论」做锚点：开放任意态
  // 输入后，用户在 running 期间发的消息会被同轮新生的 worker question 覆盖（评论时间 < 问题时间
  // → 现行谓词漏判），导致 worker 翻入 waiting 后认为没新回复、消息丢失。
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
                 (SELECT max(te.created_at)
                    FROM task_events te
                   WHERE te.task_id = tasks.id
                     AND te.event_type IN ('resumed', 'rerun_started')),
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

// 失败/取消续接重试：认领本 Worker 自己的、已被用户请求重试(retry_requested_at 非空)的 failed/cancelled
// 任务，原子翻为 running 并清空重试戳(避免重复认领)。claimed_by 机器锁定保证同工作树 + 同机 Claude 会话磁盘
// （失败/取消时保留了工作树，见 docs/spec/task-event-timeline-retry.md §4.3）。
export async function claimNextRetryableTask(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<Task | null> {
  const result = await client.query<Task>(
    `WITH candidate AS (
       SELECT tasks.id
         FROM tasks
        WHERE tasks.status IN (${sqlInList(RETRYABLE_STATUSES)})
          AND tasks.claimed_by = $1
          AND tasks.retry_requested_at IS NOT NULL
        ORDER BY tasks.retry_requested_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tasks
        SET status = 'running',
            retry_requested_at = null,
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
  // 仅当从非 waiting 转入 waiting 才发通知，避免 worker 周期续接里反复打 waiting 翻新触发轰炸。
  // RETURNING 透出旧 status（FROM 子查询拿原值），调用方据此判断是否首次进入 waiting。
  const result = await client.query<{ prev_status: string | null }>(
    `WITH prev AS (
       SELECT status AS prev_status FROM tasks WHERE id = $1 AND claimed_by = $2
     )
     UPDATE tasks
        SET status = 'waiting',
            claude_session_id = COALESCE($3, claude_session_id),
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2
      RETURNING (SELECT prev_status FROM prev) AS prev_status`,
    [taskId, workerId, sessionId]
  );
  const prevStatus = result.rows[0]?.prev_status ?? null;
  if (prevStatus !== "waiting") {
    const taskMeta = await getTaskMetaForNotify(client, taskId);
    if (taskMeta) {
      await emitTaskNotification(client, {
        type: "task_waiting",
        taskId,
        projectId: taskMeta.project_id,
        title: `任务「${taskMeta.title}」等待回复`,
        body: "Worker 提出了一个问题，请到任务详情「对话」里回复。"
      });
    }
  }
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
  const comments = result.rows;
  if (comments.length === 0) {
    return comments;
  }
  // 一次性按 task 维度拉所有 comment 的附件，再按 task_comment_id 分桶——避免 N+1。
  const byComment = await listAttachmentsByCommentIds(
    client,
    comments.map((c) => c.id)
  );
  for (const c of comments) {
    c.attachments = byComment.get(c.id) ?? [];
  }
  return comments;
}

// 取「上一次 resumed / rerun_started 事件之后」的所有 user 评论，按时间拼接为续接回复。
// 用事件而非 worker 评论作锚点：开放任意态输入后，用户在 running 期间发的消息也能被下一轮 resume
// 一并消费——若以 worker 评论为锚点，同轮新生的 worker question 会把这些消息排到锚点之前导致丢失。
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
          (SELECT max(created_at) FROM task_events
            WHERE task_id = $1 AND event_type IN ('resumed', 'rerun_started')),
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

// 某 worker 的指令历史（Console 详情页「下发命令」面板回显结果）。按下发时间倒序。
export async function listWorkerDirectCommands(
  client: pg.Pool | pg.PoolClient,
  workerId: string,
  limit = 20
): Promise<DirectCommand[]> {
  const result = await client.query<DirectCommand>(
    `SELECT *
       FROM direct_commands
      WHERE worker_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [workerId, limit]
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
    `SELECT tasks.*,
            projects.name AS project_name,
            workers.name AS worker_name
       FROM tasks
       JOIN projects ON projects.id = tasks.project_id
       JOIN user_project_links upl ON upl.project_id = tasks.project_id AND upl.user_id = $2
       LEFT JOIN workers ON workers.id = tasks.claimed_by
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
// 可选筛选：projectId / workerId 精确过滤；keyword 在 title / project_name / worker_name / branch 上 ILIKE。
export async function listConversations(
  client: pg.Pool | pg.PoolClient,
  options: {
    projectIds: string[] | null;
    limit?: number;
    projectId?: string | null;
    workerId?: string | null;
    keyword?: string | null;
  } = { projectIds: null }
): Promise<Conversation[]> {
  const keyword = options.keyword?.trim() ? `%${options.keyword.trim()}%` : null;
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
        AND ($3::uuid IS NULL OR conversations.project_id = $3)
        AND ($4::uuid IS NULL OR conversations.worker_id = $4)
        AND ($5::text IS NULL
             OR conversations.title ILIKE $5
             OR projects.name ILIKE $5
             OR workers.name ILIKE $5
             OR conversations.branch ILIKE $5)
      ORDER BY conversations.updated_at DESC
      LIMIT $2`,
    [
      options.projectIds,
      options.limit ?? 100,
      options.projectId ?? null,
      options.workerId ?? null,
      keyword
    ]
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

// 失败收尾：仅在仍处于 in-flight（pending/streaming）时才翻 failed，避免被已落 'cancelled' 终态的轮被回头覆盖。
// 后置 catch 路径里：Console 端取消会先把消息打成 'cancelled'+杀进程，进程被杀后 runClaude* 抛错走到这里——必须守住。
export async function failConversationTurn(
  client: pg.Pool | pg.PoolClient,
  input: { messageId: string; errorMessage: string }
): Promise<void> {
  await client.query(
    `UPDATE conversation_messages
        SET status = 'failed', error_message = $2, updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'streaming')`,
    [input.messageId, input.errorMessage]
  );
}

// Console 请求终止某会话的在途轮：标记本会话最后一条 in-flight assistant 消息。
// 返回该消息（含 conversation_id / claimed_by 供 publish + 路由 worker 频道）；若没有在途轮则返回 null（Console 据此提示「无可终止」）。
export async function requestConversationTurnCancellation(
  client: pg.Pool | pg.PoolClient,
  conversationId: string
): Promise<ConversationMessage | null> {
  const result = await client.query<ConversationMessage>(
    `UPDATE conversation_messages
        SET cancel_requested_at = now(), updated_at = now()
      WHERE id = (
        SELECT id FROM conversation_messages
         WHERE conversation_id = $1
           AND role = 'assistant'
           AND status IN ('pending', 'streaming')
         ORDER BY seq DESC
         LIMIT 1)
     RETURNING *`,
    [conversationId]
  );
  return result.rows[0] ?? null;
}

// Worker 周期扫描:本机名下、仍在途、已被请求取消的会话 assistant 消息。命中则 Worker 杀进程并翻 cancelled。
export async function listCancelRequestedConversationMessages(
  client: pg.Pool | pg.PoolClient,
  workerId: string
): Promise<{ id: string; conversation_id: string }[]> {
  const result = await client.query<{ id: string; conversation_id: string }>(
    `SELECT id, conversation_id FROM conversation_messages
      WHERE claimed_by = $1
        AND cancel_requested_at IS NOT NULL
        AND status IN ('pending', 'streaming')`,
    [workerId]
  );
  return result.rows;
}

// Worker 取消落终态：仅在途态可翻为 cancelled（守卫防覆盖已成功完成的轮）。返回是否成功翻转。
export async function markConversationTurnCancelled(
  client: pg.Pool | pg.PoolClient,
  messageId: string,
  workerId: string
): Promise<boolean> {
  const result = await client.query(
    `UPDATE conversation_messages
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND claimed_by = $2 AND status IN ('pending', 'streaming')`,
    [messageId, workerId]
  );
  const cancelled = (result.rowCount ?? 0) > 0;
  if (cancelled) {
    // 顺手 bump conversations.updated_at，让会话列表按活跃排序与列表派生 generating=false 同步。
    await client.query(
      `UPDATE conversations
          SET updated_at = now()
         WHERE id = (SELECT conversation_id FROM conversation_messages WHERE id = $1)`,
      [messageId]
    );
  }
  return cancelled;
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

/* ===== 多仓任务支持（project_repos + task_repos）=====
 * 方案：docs/spec/task-multi-repo.md
 *
 * 单仓项目：task_repos 仅一行(role='main')，循环 finalize 等价于老 finalizeTask；
 *           projects 与 project_repos 主仓行始终保持一致（由 syncMainProjectRepo 维护）。
 *
 * 强语义：任一仓 sub_status='failed' → 任务整体 failed（任务级状态机不变，聚合见 worker finalize）。
 */

// 列出项目所有仓（主仓行 + 子仓行）。主仓在最前（role 排序 'main' < 'sub'），随后按 position 升序。
export async function listProjectRepos(
  client: pg.Pool | pg.PoolClient,
  projectId: string
): Promise<ProjectRepo[]> {
  const result = await client.query<ProjectRepo>(
    `SELECT * FROM project_repos
      WHERE project_id = $1
      ORDER BY (role = 'main') DESC, position ASC, created_at ASC`,
    [projectId]
  );
  return result.rows;
}

// 同步主仓行：从 projects 读 repo_url / default_branch / name 填到 role='main' 行。
// createProject / updateProject 之后调用，保证主仓行与 projects 一致。
// 幂等：UPSERT 命中 partial unique index `project_repos_main_uniq`(project_id WHERE role='main')。
// projects 不存在则什么也不做（无 RAISE）。
export async function syncMainProjectRepo(
  client: pg.Pool | pg.PoolClient,
  projectId: string
): Promise<void> {
  // 因为约束改为 UNIQUE(project_id, repo_url)，且主仓的 repo_url 来自 projects（可能改名），
  // 这里走「先更新已存在的主仓行 → 没行就插入」两步，保持幂等且不依赖 ON CONFLICT 目标列。
  const upd = await client.query(
    `UPDATE project_repos pr
        SET repo_url       = p.repo_url,
            default_branch = p.default_branch,
            name           = p.name,
            updated_at     = now()
       FROM projects p
      WHERE pr.project_id = $1 AND pr.role = 'main' AND p.id = $1`,
    [projectId]
  );
  if ((upd.rowCount ?? 0) === 0) {
    await client.query(
      `INSERT INTO project_repos (project_id, role, repo_url, default_branch, name, description, position)
       SELECT id, 'main', repo_url, default_branch, name, '', 0 FROM projects WHERE id = $1
       ON CONFLICT (project_id, repo_url) DO NOTHING`,
      [projectId]
    );
  }
}

export type ProjectRepoInput = {
  name: string;
  repoUrl: string;
  defaultBranch: string;
  description: string;
  position: number;
};

// 整批替换项目的「子仓」清单（主仓行不受影响，由 syncMainProjectRepo 维护）。
// 同事务里 DELETE 缺失子仓 + UPSERT 现有子仓（按 repo_url 匹配，保留 id 不变以避免外键级联误删 task_repos）。
// 上层须在事务内调用：传入 PoolClient。
export async function replaceProjectSubRepos(
  client: pg.PoolClient,
  projectId: string,
  subs: ProjectRepoInput[]
): Promise<void> {
  // 校验：repoUrl 必填、同项目内不可重复（DB 上有 UNIQUE(project_id, repo_url) 兜底，这里早报错友好些）。
  const seen = new Set<string>();
  for (const sub of subs) {
    if (!sub.repoUrl) {
      throw new Error("子仓 repoUrl 不能为空");
    }
    if (seen.has(sub.repoUrl)) {
      throw new Error(`子仓 repoUrl 重复：${sub.repoUrl}`);
    }
    seen.add(sub.repoUrl);
  }

  // 删除当前不在提交清单里的子仓行。ON DELETE RESTRICT 会在它们有 task_repos 引用时报错——
  // 此时上层应明确告知用户该子仓还有任务依赖，需先处理任务后再移除。
  const keepUrls = subs.map((s) => s.repoUrl);
  await client.query(
    `DELETE FROM project_repos
      WHERE project_id = $1
        AND role = 'sub'
        AND NOT (repo_url = ANY($2::text[]))`,
    [projectId, keepUrls]
  );

  // upsert：以 (project_id, repo_url) 为匹配键。
  for (const sub of subs) {
    await client.query(
      `INSERT INTO project_repos
         (project_id, role, repo_url, default_branch, name, description, position)
       VALUES ($1, 'sub', $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, repo_url) DO UPDATE
          SET default_branch = EXCLUDED.default_branch,
              name           = EXCLUDED.name,
              description    = EXCLUDED.description,
              position       = EXCLUDED.position,
              updated_at     = now()`,
      [projectId, sub.repoUrl, sub.defaultBranch, sub.name, sub.description, sub.position]
    );
  }
}

// 列出任务的所有仓快照行（主仓在前，子仓按 relative_path 排序）。
export async function listTaskRepos(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<TaskRepo[]> {
  const result = await client.query<TaskRepo>(
    `SELECT * FROM task_repos
      WHERE task_id = $1
      ORDER BY (role = 'main') DESC, relative_path ASC`,
    [taskId]
  );
  return result.rows;
}

export type TaskRepoInput = {
  projectRepoId: string;
  role: ProjectRepoRole;
  relativePath: string;
  baseBranch: string;
  workBranch: string;
  targetBranch: string;
  // 用户在 UI 上勾掉该仓（不启用）时传 'skipped'；其余创建时一律 'pending'。
  subStatus?: TaskRepoSubStatus;
};

// 任务创建后批量写入 task_repos。期望调用方在同事务内、createTask 之后调用。
// 入参须至少包含一行 role='main'；上层在 console route 校验。
export async function createTaskRepos(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  inputs: TaskRepoInput[]
): Promise<void> {
  if (inputs.length === 0) {
    throw new Error("createTaskRepos: 至少需要一行（含主仓）");
  }
  const mainCount = inputs.filter((i) => i.role === "main").length;
  if (mainCount !== 1) {
    throw new Error(`createTaskRepos: 须恰好一行 role='main'，当前 ${mainCount} 行`);
  }
  for (const input of inputs) {
    await client.query(
      `INSERT INTO task_repos
         (task_id, project_repo_id, role, relative_path,
          base_branch, work_branch, target_branch, sub_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        taskId,
        input.projectRepoId,
        input.role,
        input.relativePath,
        input.baseBranch,
        input.workBranch,
        input.targetBranch,
        input.subStatus ?? "pending"
      ]
    );
  }
}

// 删除任务的全部 task_repos（updateTask 重新生成时用；外键 ON DELETE CASCADE 在删任务时已覆盖，
// 这里专供「编辑任务时整批替换分支配置」的场景：先 DELETE 再 createTaskRepos）。
export async function deleteTaskRepos(client: pg.Pool | pg.PoolClient, taskId: string): Promise<void> {
  await client.query(`DELETE FROM task_repos WHERE task_id = $1`, [taskId]);
}

// 单仓状态翻转（finalize 单仓收尾用）。同步打 last_sync_at。
// errorMessage 仅 sub_status='failed' 时有意义；其它态传 null 清空。
export async function updateTaskRepoStatus(
  client: pg.Pool | pg.PoolClient,
  taskRepoId: string,
  subStatus: TaskRepoSubStatus,
  errorMessage: string | null = null
): Promise<void> {
  await client.query(
    `UPDATE task_repos
        SET sub_status    = $2,
            error_message = $3,
            last_sync_at  = now(),
            updated_at    = now()
      WHERE id = $1`,
    [taskRepoId, subStatus, errorMessage]
  );
}

// 单仓 pr_url 写入（gh pr create 成功后调用）。不动 sub_status——由调用方后续 updateTaskRepoStatus
// 翻成 'pr_created'。
export async function updateTaskRepoPrUrl(
  client: pg.Pool | pg.PoolClient,
  taskRepoId: string,
  prUrl: string | null
): Promise<void> {
  await client.query(
    `UPDATE task_repos SET pr_url = $2, updated_at = now() WHERE id = $1`,
    [taskRepoId, prUrl]
  );
}

// 子仓 relative_path 改写：worker prepare 阶段把占位 '*-<projectRepoId>' 替换为本机派生路径
// （docs/spec/project-repos-runtime-path.md）。同 task 内若两个子仓 resolve 到同名目录，
// UNIQUE(task_id, relative_path) 会拒绝写入，由调用方捕获报错让任务 failed。
export async function updateTaskRepoRelativePath(
  client: pg.Pool | pg.PoolClient,
  taskRepoId: string,
  relativePath: string
): Promise<void> {
  await client.query(
    `UPDATE task_repos SET relative_path = $2, updated_at = now() WHERE id = $1`,
    [taskRepoId, relativePath]
  );
}

// =============================================================================
// 附件（任务/评论附件）。详见 docs/spec/task-attachments.md
//
// - DB 仅元数据 + storage_path（相对 CLAUDE_CENTER_UPLOAD_DIR）；二进制不入库。
// - 两阶段：上传时落 owner_user_id（task_id/comment_id 均 NULL）→ 创建 task / comment 时事务里绑定。
// - listAttachmentsByCommentIds 是 listTaskComments 的 N+1 防御，列表/详情都走它。
// =============================================================================

// 元数据 SELECT 共用列：不暴露 storage_path / 归属字段给 UI 与 Worker。
const ATTACHMENT_META_COLS =
  `id, kind, mime, size_bytes, sha256, original_name, created_at`;

// Attachment 行不暴露 bytea；元数据列固定，避免 SELECT * 习惯性误拖大对象。
const ATTACHMENT_ROW_COLS =
  `id, task_id, task_comment_id, owner_user_id, ${ATTACHMENT_META_COLS}`;

export async function createAttachment(
  client: pg.Pool | pg.PoolClient,
  input: {
    ownerUserId: string;
    kind: AttachmentKind;
    mime: string;
    sizeBytes: number;
    sha256: string;
    originalName: string;
    data: Buffer;
  }
): Promise<Attachment> {
  // 元数据 + blob 同事务两步插入；任一失败回滚到原状态。bytea 经 node-postgres 直传 Buffer。
  const meta = await client.query<Attachment>(
    `INSERT INTO attachments
       (owner_user_id, kind, mime, size_bytes, sha256, original_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ATTACHMENT_ROW_COLS}`,
    [
      input.ownerUserId,
      input.kind,
      input.mime,
      input.sizeBytes,
      input.sha256,
      input.originalName
    ]
  );
  const row = meta.rows[0]!;
  await client.query(`INSERT INTO attachment_blobs (attachment_id, data) VALUES ($1, $2)`, [
    row.id,
    input.data
  ]);
  return row;
}

export async function getAttachment(
  client: pg.Pool | pg.PoolClient,
  id: string
): Promise<Attachment | null> {
  const result = await client.query<Attachment>(
    `SELECT ${ATTACHMENT_ROW_COLS} FROM attachments WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] ?? null;
}

// 取元数据 + bytea：Console download 路由与 Worker 直读用。
// bytea 经 node-postgres 默认作 Buffer 返回。
export async function getAttachmentBlob(
  client: pg.Pool | pg.PoolClient,
  id: string
): Promise<{ meta: Attachment; data: Buffer } | null> {
  const result = await client.query<Attachment & { data: Buffer }>(
    `SELECT ${ATTACHMENT_ROW_COLS}, b.data AS data
       FROM attachments a JOIN attachment_blobs b ON b.attachment_id = a.id
      WHERE a.id = $1
      LIMIT 1`,
    [id]
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const { data, ...meta } = row;
  return { meta: meta as Attachment, data };
}

export async function listAttachmentsForTask(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<AttachmentMeta[]> {
  const result = await client.query<AttachmentMeta>(
    `SELECT ${ATTACHMENT_META_COLS} FROM attachments
      WHERE task_id = $1
      ORDER BY created_at ASC`,
    [taskId]
  );
  return result.rows;
}

export async function listAttachmentsForComment(
  client: pg.Pool | pg.PoolClient,
  commentId: string
): Promise<AttachmentMeta[]> {
  const result = await client.query<AttachmentMeta>(
    `SELECT ${ATTACHMENT_META_COLS} FROM attachments
      WHERE task_comment_id = $1
      ORDER BY created_at ASC`,
    [commentId]
  );
  return result.rows;
}

// 一次性按 comment_id 集合拉附件，按 comment_id 分桶——listTaskComments / Worker 详情拉取共用。
export async function listAttachmentsByCommentIds(
  client: pg.Pool | pg.PoolClient,
  commentIds: string[]
): Promise<Map<string, AttachmentMeta[]>> {
  const map = new Map<string, AttachmentMeta[]>();
  if (commentIds.length === 0) {
    return map;
  }
  const result = await client.query<AttachmentMeta & { task_comment_id: string }>(
    `SELECT ${ATTACHMENT_META_COLS}, task_comment_id FROM attachments
      WHERE task_comment_id = ANY($1::uuid[])
      ORDER BY created_at ASC`,
    [commentIds]
  );
  for (const row of result.rows) {
    const list = map.get(row.task_comment_id);
    const meta: AttachmentMeta = {
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      original_name: row.original_name,
      created_at: row.created_at
    };
    if (list) {
      list.push(meta);
    } else {
      map.set(row.task_comment_id, [meta]);
    }
  }
  return map;
}

// 绑定附件到任务。仅未绑定 + 归属本用户的行才能绑（管理员通过 ownerUserId=null 绕过 owner 检查）。
// 命中 < ids.length 时抛错（事务回滚）。
export async function bindAttachmentsToTask(
  client: pg.Pool | pg.PoolClient,
  taskId: string,
  attachmentIds: string[],
  ownerUserId: string | null
): Promise<void> {
  if (attachmentIds.length === 0) {
    return;
  }
  const unique = [...new Set(attachmentIds)];
  const ownerClause = ownerUserId ? `AND owner_user_id = $3` : "";
  const params: unknown[] = [unique, taskId];
  if (ownerUserId) {
    params.push(ownerUserId);
  }
  const result = await client.query(
    `UPDATE attachments
        SET task_id = $2
      WHERE id = ANY($1::uuid[])
        AND task_id IS NULL
        AND task_comment_id IS NULL
        ${ownerClause}`,
    params
  );
  if ((result.rowCount ?? 0) !== unique.length) {
    throw new Error("部分附件不存在、已被绑定或无权使用");
  }
}

// 绑定附件到评论：同 bindAttachmentsToTask。
export async function bindAttachmentsToComment(
  client: pg.Pool | pg.PoolClient,
  commentId: string,
  attachmentIds: string[],
  ownerUserId: string | null
): Promise<void> {
  if (attachmentIds.length === 0) {
    return;
  }
  const unique = [...new Set(attachmentIds)];
  const ownerClause = ownerUserId ? `AND owner_user_id = $3` : "";
  const params: unknown[] = [unique, commentId];
  if (ownerUserId) {
    params.push(ownerUserId);
  }
  const result = await client.query(
    `UPDATE attachments
        SET task_comment_id = $2
      WHERE id = ANY($1::uuid[])
        AND task_id IS NULL
        AND task_comment_id IS NULL
        ${ownerClause}`,
    params
  );
  if ((result.rowCount ?? 0) !== unique.length) {
    throw new Error("部分附件不存在、已被绑定或无权使用");
  }
}

// 删除未绑定附件（撤销刚上传的草稿）。FK CASCADE 保证 attachment_blobs 同步删。
// ownerUserId=null 表示 admin 强删；其他用户仅能删自己上传且未绑定的行。返回 true=命中。
export async function deleteUnboundAttachment(
  client: pg.Pool | pg.PoolClient,
  id: string,
  ownerUserId: string | null
): Promise<boolean> {
  const ownerClause = ownerUserId ? `AND owner_user_id = $2` : "";
  const params: unknown[] = [id];
  if (ownerUserId) {
    params.push(ownerUserId);
  }
  const result = await client.query(
    `DELETE FROM attachments
      WHERE id = $1
        AND task_id IS NULL
        AND task_comment_id IS NULL
        ${ownerClause}`,
    params
  );
  return (result.rowCount ?? 0) > 0;
}

// 批量清理过期未绑定孤儿（worker 定期清理用）。FK CASCADE 同时删 blob。
export async function deleteOrphanedAttachments(
  client: pg.Pool | pg.PoolClient,
  olderThanHours: number,
  limit = 500
): Promise<number> {
  const result = await client.query(
    `DELETE FROM attachments
      WHERE id IN (
        SELECT id FROM attachments
         WHERE task_id IS NULL
           AND task_comment_id IS NULL
           AND created_at < now() - ($1 || ' hours')::interval
         ORDER BY created_at ASC
         LIMIT $2
      )`,
    [String(olderThanHours), limit]
  );
  return result.rowCount ?? 0;
}

// ===== 用户消息通知（029_notifications.sql）。详见 docs/spec 或建表迁移。 =====
//
// 写入策略：
// - task_*：fanout 给「能看到该项目的用户」（admin 全部 + user_project_links 关联用户）。
// - worker_*：fanout 给全部 admin（worker 是机群资源，非项目维度）。
// 所有 insert 都用 INSERT...SELECT，避免在 worker / UI 调用方循环出 N 次 query。
// 写入失败 / 表不存在不抛错——通知是辅助信号，不该把主路径拖崩；调用方一律忽略返回值。

type EmitTaskNotificationInput = {
  type: Extract<NotificationType, "task_claimed" | "task_waiting" | "task_success" | "task_failed" | "task_pr_created">;
  taskId: string;
  projectId: string;
  title: string;
  body?: string;
  link?: string;
};

// 给「能看到该项目」的所有用户（admin + user_project_links 关联用户）落通知。
// 重复 fanout 时（同 taskId+type）按时间顺序累积，UI 侧按 created_at 显示最新的即可。
export async function emitTaskNotification(
  client: pg.Pool | pg.PoolClient,
  input: EmitTaskNotificationInput
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link, related_task_id)
       SELECT u.id, $1, $2, $3, $4, $5
         FROM users u
        WHERE u.disabled = false
          AND (
            u.role = 'admin'
            OR EXISTS (
              SELECT 1 FROM user_project_links upl
               WHERE upl.user_id = u.id AND upl.project_id = $6
            )
          )`,
      [input.type, input.title, input.body ?? "", input.link ?? `/tasks/${input.taskId}`, input.taskId, input.projectId]
    );
  } catch (error) {
    // 表不存在 / 临时连接问题：不阻塞主路径。worker 周期会反复触发，丢一两条无伤大雅。
    console.warn(`[notifications] emitTaskNotification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 给全部活跃 admin 落 worker 上下线通知。worker_* 不针对项目。
export async function emitWorkerNotification(
  client: pg.Pool | pg.PoolClient,
  input: {
    type: Extract<NotificationType, "worker_online" | "worker_offline">;
    workerId: string;
    title: string;
    body?: string;
    link?: string;
  }
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO notifications (user_id, type, title, body, link, related_worker_id)
       SELECT u.id, $1, $2, $3, $4, $5
         FROM users u
        WHERE u.disabled = false AND u.role = 'admin'`,
      [input.type, input.title, input.body ?? "", input.link ?? `/workers`, input.workerId]
    );
  } catch (error) {
    console.warn(`[notifications] emitWorkerNotification failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 用户铃铛下拉用：按时间倒序列出该用户的最近通知（默认 30 条）。
export async function listNotifications(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  limit = 30
): Promise<Notification[]> {
  const result = await client.query<Notification>(
    `SELECT * FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

// 铃铛红点用：返回未读条数。
export async function countUnreadNotifications(
  client: pg.Pool | pg.PoolClient,
  userId: string
): Promise<number> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return result.rows[0]?.count ?? 0;
}

// 单条标记已读：仅本人未读条目命中（已读再点幂等）。
export async function markNotificationRead(
  client: pg.Pool | pg.PoolClient,
  userId: string,
  notificationId: string
): Promise<void> {
  await client.query(
    `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [notificationId, userId]
  );
}

// 全部标记已读。
export async function markAllNotificationsRead(
  client: pg.Pool | pg.PoolClient,
  userId: string
): Promise<void> {
  await client.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
}

// Worker resume 路径用：聚合「上一次 resumed/rerun_started 事件之后」所有 user
// 评论的附件。跟 getPendingReply 的文本逻辑配套：那边返回拼接 body，这边返回拼接 attachments。
export async function listPendingReplyAttachments(
  client: pg.Pool | pg.PoolClient,
  taskId: string
): Promise<AttachmentMeta[]> {
  const result = await client.query<AttachmentMeta>(
    `SELECT ${ATTACHMENT_META_COLS}
       FROM attachments a
      WHERE a.task_comment_id IN (
        SELECT id FROM task_comments
         WHERE task_id = $1
           AND author = 'user'
           AND created_at > COALESCE(
             (SELECT max(created_at) FROM task_events
               WHERE task_id = $1 AND event_type IN ('resumed', 'rerun_started')),
             'epoch'::timestamptz)
      )
      ORDER BY a.created_at ASC`,
    [taskId]
  );
  return result.rows;
}
