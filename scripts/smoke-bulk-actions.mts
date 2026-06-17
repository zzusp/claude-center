// 行为冒烟：批量管理 6 个动作（publish / unpublish / cancel / reactivate / retry / delete）
// 与 apps/console/app/api/tasks/bulk/route.ts 的 runAction() 调用链一致——直接调 DB helpers 验证
// 每个动作的状态机翻转是否真的生效（accept 已随人工验收一并移除,见 docs/spec/drop-accepted-rejected.md）。
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-bulk-actions.mts
import {
  closePool,
  createTask,
  deleteTask,
  getPool,
  publishTask,
  reactivateTask,
  requestTaskCancellation,
  requestTaskRetry,
  unpublishTask
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-000000000010";

async function seedProject(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Bulk Smoke Project', 'https://example.invalid/x.git', 'main')`,
    [PROJECT_ID]
  );
}

async function mkTask(title: string): Promise<string> {
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
    scheduledAt: null
  });
  return task.id;
}

// 直接改 status，模拟「认领/执行后落到指定终态/中间态」用于验收/取消/激活/重试/删除场景。
async function forceStatus(id: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const pool = getPool();
  const sets: string[] = ["status = $2", "updated_at = now()"];
  const values: unknown[] = [id, status];
  let i = 3;
  for (const [col, val] of Object.entries(extra)) {
    sets.push(`${col} = $${i}`);
    values.push(val);
    i += 1;
  }
  await pool.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1`, values);
}

async function getStatus(id: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [id]);
  return r.rows[0]?.status ?? null;
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function main(): Promise<void> {
  await seedProject();

  // 1) publish: draft → pending
  const pubId = await mkTask("publish-case");
  const pubRes = await publishTask(getPool(), pubId);
  if (!pubRes) throw new Error("publish: 返回 null（未命中状态守卫）");
  assertEq(pubRes.status, "pending", "publish.status");
  console.log("✓ publish: draft → pending");

  // 2) unpublish: pending → draft
  const unpId = await mkTask("unpublish-case");
  await publishTask(getPool(), unpId); // 先到 pending
  const unpRes = await unpublishTask(getPool(), unpId);
  if (!unpRes) throw new Error("unpublish: 返回 null");
  assertEq(unpRes.status, "draft", "unpublish.status");
  console.log("✓ unpublish: pending → draft");

  // 3) cancel: 在途态（claimed）→ cancel_requested_at 落标记（状态本身仍是 claimed，Worker 后续翻 cancelled）
  const cancelId = await mkTask("cancel-case");
  await forceStatus(cancelId, "claimed", { claimed_at: new Date().toISOString() });
  const cancelRes = await requestTaskCancellation(getPool(), cancelId);
  if (!cancelRes) throw new Error("cancel: 返回 null");
  if (!cancelRes.cancel_requested_at) throw new Error("cancel: cancel_requested_at 未落");
  console.log("✓ cancel: claimed → cancel_requested_at 已落");

  // 5) reactivate: failed → draft
  const reactId = await mkTask("reactivate-case");
  await forceStatus(reactId, "failed", { error_message: "boom" });
  const reactRes = await reactivateTask(getPool(), reactId);
  if (!reactRes) throw new Error("reactivate: 返回 null");
  assertEq(reactRes.status, "draft", "reactivate.status");
  if (reactRes.error_message !== null) throw new Error("reactivate: error_message 未清空");
  console.log("✓ reactivate: failed → draft（现场已清）");

  // 6) retry: cancelled → retry_requested_at 落标记（状态保留 cancelled，Worker 续接）
  const retryId = await mkTask("retry-case");
  await forceStatus(retryId, "cancelled");
  const retryRes = await requestTaskRetry(getPool(), retryId);
  if (!retryRes) throw new Error("retry: 返回 null");
  if (!retryRes.retry_requested_at) throw new Error("retry: retry_requested_at 未落");
  assertEq(retryRes.status, "cancelled", "retry.status（保留原状态）");
  console.log("✓ retry: cancelled → retry_requested_at 已落");

  // 7) delete: 非 claimed/running 均可删
  const delDraftId = await mkTask("delete-draft-case");
  const delFailedId = await mkTask("delete-failed-case");
  await forceStatus(delFailedId, "failed");
  const delDraftOk = await deleteTask(getPool(), delDraftId);
  const delFailedOk = await deleteTask(getPool(), delFailedId);
  if (!delDraftOk) throw new Error("delete(draft) 失败");
  if (!delFailedOk) throw new Error("delete(failed) 失败");
  assertEq(await getStatus(delDraftId), null, "delete(draft).gone");
  assertEq(await getStatus(delFailedId), null, "delete(failed).gone");
  console.log("✓ delete: draft / failed 均删除成功");

  // 8) 守卫负例：delete 在 running 上必须拒绝；publish 在 success 上必须拒绝
  const guardRunId = await mkTask("guard-running");
  await forceStatus(guardRunId, "running", { claimed_at: new Date().toISOString(), started_at: new Date().toISOString() });
  const delRun = await deleteTask(getPool(), guardRunId);
  if (delRun) throw new Error("delete 守卫失效：running 应不可删");
  console.log("✓ guard: delete(running) 被拒绝");

  const guardSucId = await mkTask("guard-success");
  await forceStatus(guardSucId, "success");
  const pubSuc = await publishTask(getPool(), guardSucId);
  if (pubSuc) throw new Error("publish 守卫失效：success 不应可发布");
  console.log("✓ guard: publish(success) 被拒绝");

  console.log("\nall bulk action helpers verified");
}

try {
  await main();
} finally {
  await closePool();
}
