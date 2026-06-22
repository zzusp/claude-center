// 行为冒烟（goal 2）：失败 / 取消的任务即使「没有 Claude 会话」(claude_session_id 为空)，用户回复一条
// user 评论后也应被 claimNextResumableTask 认领续接（带补充全新执行），而不是被「非在途 / 无会话」挡住。
// 同时验证：有会话的终态仍可认领（不回归）+ 认领后即打 resume_claimed 锚点防失败重领。
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs docs/acceptance/failed-task-retry-reply/scripts/smoke-reply-no-session.mts
import {
  addTaskComment,
  claimNextResumableTask,
  closePool,
  createTask,
  getPool,
  registerWorker
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-000000000040";
const WORKER_ID = "00000000-0000-0000-0000-0000000000c4";

async function seed(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Reply No-Session Project', 'https://example.invalid/y.git', 'main')`,
    [PROJECT_ID]
  );
  await registerWorker(pool, { id: WORKER_ID, name: "Reply Worker", hostName: "smoke-host", appVersion: "0.0.0" });
}

// 造一个「该 worker 认领过、已 failed、无会话」的任务（模拟失败在 worktree 准备阶段、Claude 还没产出 session）。
async function mkFailedNoSession(): Promise<string> {
  const pool = getPool();
  const task = await createTask(pool, {
    projectId: PROJECT_ID,
    title: "失败任务重试问题修复",
    description: "smoke",
    baseBranch: "main",
    workBranch: "cc/task-no-session",
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  });
  await pool.query(
    `UPDATE tasks
        SET status='failed', claimed_by=$2, claimed_at=now(), started_at=now(), finished_at=now(),
            claude_session_id=NULL, error_message='git worktree add ... already exists', updated_at=now()
      WHERE id=$1`,
    [task.id, WORKER_ID]
  );
  return task.id;
}

async function getStatus(id: string): Promise<string | null> {
  const r = await getPool().query<{ status: string }>(`SELECT status FROM tasks WHERE id=$1`, [id]);
  return r.rows[0]?.status ?? null;
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  await seed();

  // —— 1) 无会话失败任务：无回复时不被认领（无活可干）—— //
  const id = await mkFailedNoSession();
  const c0 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c0 === null, "无会话失败任务且无回复 → 不被认领");

  // —— 2) 用户补一条回复 → 应被认领续接（这是 goal 2 的核心：失败任务也能回复接着干）—— //
  await addTaskComment(getPool(), { taskId: id, author: "user", workerId: null, body: "补充：worktree 已存在，复用即可" });
  const c1 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c1?.id === id, "无会话失败任务收到回复后被认领（修复前会被 claude_session_id IS NOT NULL 挡住）");
  assert((await getStatus(id)) === "running", "认领后翻 running");
  const marker = await getPool().query<{ n: string }>(
    `SELECT count(*) AS n FROM task_events WHERE task_id=$1 AND event_type='resume_claimed'`,
    [id]
  );
  assert(Number(marker.rows[0]!.n) === 1, "认领同事务落了 1 条 resume_claimed 锚点（防失败重领）");

  // —— 3) 同一条回复不再被重领（resume_claimed 锚点已推进；防无限循环 / 取消失效）—— //
  await getPool().query(`UPDATE tasks SET status='failed', finished_at=now(), updated_at=now() WHERE id=$1`, [id]);
  const c2 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c2 === null, "同一回复失败后不再重领（锚点推进，循环停住）");

  // —— 4) 有会话的终态仍可认领（不回归原行为）—— //
  const id2 = await mkFailedNoSession();
  await getPool().query(`UPDATE tasks SET claude_session_id='1111aaaa-2222-bbbb-3333-cccc4444dddd' WHERE id=$1`, [id2]);
  await addTaskComment(getPool(), { taskId: id2, author: "user", workerId: null, body: "继续" });
  const c3 = await claimNextResumableTask(getPool(), WORKER_ID);
  assert(c3?.id === id2, "有会话的失败任务收到回复仍被认领（未回归）");

  console.log("\nall reply-no-session assertions passed");
}

try {
  await main();
} finally {
  await closePool();
}
