// 行为冒烟：复现任务 9f51616a 的「停不下来」无限重领循环，并验证修复（claimNextResumableTask
// 认领即打 resume_claimed 锚点）能在一次失败后停住，且不破坏正常续接 / 取消生效。
//
// 复现条件（与真实任务一致）：终态(failed/cancelled) + claude_session_id 非空 + 有一条早于任何
// resume 锚点的 user 评论 + 从未落过 'resumed'/'rerun_started'（resumeTask 在 worktree 准备阶段就抛错，
// 写 'resumed' 之前已失败）。旧逻辑下锚点恒为 epoch，该评论让任务每个 tick 被重领→失败→重领……无限循环；
// 取消刚翻 cancelled 又被重领，取消不生效。
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-resume-loop-stop.mts
import {
  addTaskComment,
  claimNextResumableTask,
  closePool,
  createTask,
  getPendingReply,
  getPool,
  markTaskFailed,
  registerWorker
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-000000000030";
const WORKER_ID = "00000000-0000-0000-0000-0000000000b2";

async function seed(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Resume Loop Project', 'https://example.invalid/x.git', 'main')`,
    [PROJECT_ID]
  );
  await registerWorker(pool, { id: WORKER_ID, name: "Loop Worker", hostName: "smoke-host", appVersion: "0.0.0" });
}

// 造一个「终态 + 有会话 + 有一条历史 user 评论 + 无 resume 锚点」的任务，模拟真实卡死现场。
async function mkStuckTask(): Promise<string> {
  const pool = getPool();
  const task = await createTask(pool, {
    projectId: PROJECT_ID,
    title: "发布1.0.4版本",
    description: "smoke",
    baseBranch: "main",
    workBranch: "worktree-release-1.0.4",
    targetBranch: "main",
    submitMode: "push",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  });
  // 用户在很早以前留过一条评论（早于任何 resume 锚点）——这正是无限重领的触发源。
  await addTaskComment(pool, { taskId: task.id, author: "user", workerId: null, body: "确认1.0.4" });
  // 落到「该 worker 认领过、有会话、已 failed」的终态。
  await pool.query(
    `UPDATE tasks
        SET status='failed', claimed_by=$2, claimed_at=now(), started_at=now(), finished_at=now(),
            claude_session_id='9312e09a-6f10-4edc-9edb-e8726a989de3', error_message='worktree prep failed', updated_at=now()
      WHERE id=$1`,
    [task.id, WORKER_ID]
  );
  return task.id;
}

async function getStatus(id: string): Promise<string | null> {
  const r = await getPool().query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [id]);
  return r.rows[0]?.status ?? null;
}

// 旧逻辑的认领谓词（锚点只看 resumed/rerun_started）——用于对照证明旧逻辑会无限重领。
async function oldGuardWouldClaim(id: string): Promise<boolean> {
  const r = await getPool().query<{ matches: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM task_comments uc
        WHERE uc.task_id=$1 AND uc.author='user'
          AND uc.created_at > COALESCE(
            (SELECT max(te.created_at) FROM task_events te
              WHERE te.task_id=$1 AND te.event_type IN ('resumed','rerun_started')),
            'epoch'::timestamptz)) AS matches`,
    [id]
  );
  return r.rows[0]!.matches;
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  await seed();
  const id = await mkStuckTask();

  // —— 1) 首次认领：应命中（有待消费评论），翻 running，并原子落 resume_claimed —— //
  const c1 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c1?.id === id, "首次 claimNextResumableTask 命中卡死任务");
  assert((await getStatus(id)) === "running", "命中后翻 running");
  const marker = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM task_events WHERE task_id=$1 AND event_type='resume_claimed'`,
    [id]
  );
  assert(Number(marker.rows[0]!.n) === 1, "认领同事务落了 1 条 resume_claimed 锚点");

  // —— 2) 认领后、写 'resumed' 之前，本轮 resume 仍能读到该回复（锚点拆分未误伤正常续接）—— //
  const reply = await getPendingReply(getPool(), id);
  assert(reply === "确认1.0.4", "认领后 getPendingReply 仍返回用户回复（resume 能注入）");

  // —— 3) 模拟 resumeTask 在 worktree 准备阶段失败（未写 'resumed' 就 markTaskFailed）—— //
  await markTaskFailed(getPool(), id, WORKER_ID, "Command failed: git worktree add ... invalid reference", {
    failedAt: new Date().toISOString()
  });
  assert((await getStatus(id)) === "failed", "resume 失败后回到 failed");

  // —— 4) 关键断言：旧逻辑此刻仍会重领（无限循环），新逻辑已停住 —— //
  assert((await oldGuardWouldClaim(id)) === true, "对照：旧谓词此刻仍会重领（证明旧逻辑无限循环）");
  const c2 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c2 === null, "修复后：同一评论不再重领，循环停住（停下来了）");
  assert((await getStatus(id)) === "failed", "任务静止在 failed，不再自动执行");

  // —— 5) 取消生效：终态任务取消后不被重领，cancel 粘住（模拟 markTaskCancelled 翻 cancelled）—— //
  await getPool().query(`UPDATE tasks SET status='cancelled', finished_at=now(), updated_at=now() WHERE id=$1`, [id]);
  const c3 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c3 === null, "cancelled 任务不被重领（取消粘住、不再自动执行）");
  assert((await getStatus(id)) === "cancelled", "任务静止在 cancelled");

  // —— 6) 正常续接仍可用：用户补一条**更晚**的新评论 → 可再次认领续接 —— //
  await addTaskComment(getPool(), { taskId: id, author: "user", workerId: null, body: "重新发布" });
  const c4 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c4?.id === id, "用户补新评论后可再次认领续接（未误杀正常续接）");
  assert((await getStatus(id)) === "running", "新评论续接后翻 running");

  console.log("\nall resume-loop-stop assertions passed");
}

try {
  await main();
} finally {
  await closePool();
}
