// 行为冒烟：复现「任务停不下来」并验证修复——非在跑(active 句柄不在)的在途任务被请求取消后，
// cancel 检查器(handleCancellations)应仍能把它翻到 cancelled 终态。
//
// 旧 handleCancellations 只遍历 this.active.values()，waiting / claimed-未起跑 / 重启丢句柄 的任务
// 不在其中 → 永远不调用 markTaskCancelled → cancel_requested_at 已落却卡在在途态(停不下来)。
// 这里直接走修复后 handler 对「非 active 任务」的数据链：listCancelRequestedTaskIds → markTaskCancelled。
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-cancel-stuck-task.mts
import {
  closePool,
  createTask,
  getPool,
  listCancelRequestedTaskIds,
  markTaskCancelled,
  registerWorker,
  requestTaskCancellation
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-000000000020";
const WORKER_ID = "00000000-0000-0000-0000-0000000000a1";

async function seed(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Cancel Stuck Project', 'https://example.invalid/x.git', 'main')`,
    [PROJECT_ID]
  );
  await registerWorker(pool, {
    id: WORKER_ID,
    name: "Cancel Stuck Worker",
    hostName: "smoke-host",
    appVersion: "0.0.0"
  });
}

async function mkClaimedTask(title: string, status: string): Promise<string> {
  const pool = getPool();
  const task = await createTask(pool, {
    projectId: PROJECT_ID,
    title,
    description: "smoke",
    baseBranch: "main",
    workBranch: `feat/${title}`,
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  });
  // 模拟「该 worker 认领后落到指定在途态」——关键：不进 worker 的内存 active 表(非在跑句柄)。
  await pool.query(
    `UPDATE tasks SET status = $2, claimed_by = $3, claimed_at = now(), updated_at = now() WHERE id = $1`,
    [task.id, status, WORKER_ID]
  );
  return task.id;
}

async function getStatus(id: string): Promise<string | null> {
  const r = await getPool().query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [id]);
  return r.rows[0]?.status ?? null;
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}

async function main(): Promise<void> {
  await seed();

  // —— 核心场景：waiting 任务(轮已结束、无 active 子进程)被请求取消 —— //
  const waitingId = await mkClaimedTask("waiting-cancel", "waiting");
  const cancelRes = await requestTaskCancellation(getPool(), waitingId);
  assert(Boolean(cancelRes?.cancel_requested_at), "waiting 任务可请求取消(cancel_requested_at 落标记)");
  assert((await getStatus(waitingId)) === "waiting", "请求取消后状态仍是 waiting(等 cancel 检查器翻终态)");

  // cancel 检查器第一步：列出本 worker 名下被请求取消的在途任务——必须包含这条非 active 的 waiting 任务。
  const ids = await listCancelRequestedTaskIds(getPool(), WORKER_ID);
  assert(ids.includes(waitingId), "listCancelRequestedTaskIds 命中非 active 的 waiting 任务");

  // cancel 检查器第二步(修复点)：对返回的每个 id 都 markTaskCancelled——非 active 任务也翻终态。
  const flipped = await markTaskCancelled(getPool(), waitingId, WORKER_ID, {
    cancelledAt: new Date().toISOString(),
    reason: "user requested"
  });
  assert(flipped, "markTaskCancelled 对非 active 的 waiting 任务翻转成功");
  assert((await getStatus(waitingId)) === "cancelled", "waiting 任务最终翻到 cancelled(停下来了)");

  // 翻转后不再出现在待取消列表(避免下一轮重复/误杀)。
  const after = await listCancelRequestedTaskIds(getPool(), WORKER_ID);
  assert(!after.includes(waitingId), "翻终态后不再出现在待取消列表");

  // —— 同根因覆盖：claimed 但尚未起跑的任务被取消，也应能翻终态 —— //
  const claimedId = await mkClaimedTask("claimed-cancel", "claimed");
  await requestTaskCancellation(getPool(), claimedId);
  assert(
    (await listCancelRequestedTaskIds(getPool(), WORKER_ID)).includes(claimedId),
    "listCancelRequestedTaskIds 命中非 active 的 claimed 任务"
  );
  const claimedFlipped = await markTaskCancelled(getPool(), claimedId, WORKER_ID, {
    cancelledAt: new Date().toISOString(),
    reason: "user requested"
  });
  assert(claimedFlipped && (await getStatus(claimedId)) === "cancelled", "claimed 任务也能翻到 cancelled");

  console.log("\nall cancel-stuck-task assertions passed");
}

try {
  await main();
} finally {
  await closePool();
}
