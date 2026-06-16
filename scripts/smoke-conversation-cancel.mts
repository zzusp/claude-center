// 行为冒烟：终止会话回答 + 列表筛选 + 失败收尾守卫。对临时干净库跑：建库 → 应用全量迁移 → 这里 seed + 校验 → DROP。
// 由 ephemeral-db.mjs 通过 --run 触发：node scripts/ephemeral-db.mjs --run scripts/smoke-conversation-cancel.mts
//
// 校验三段：
// 1) listConversations 的 keyword / projectId / workerId 筛选语义。
// 2) requestConversationTurnCancellation → markConversationTurnCancelled 的状态机：streaming → cancelled。
// 3) failConversationTurn 在「已 cancelled」上不覆盖（status 守卫）。
import {
  addConversationMessage,
  claimNextConversationTurn,
  closePool,
  createConversation,
  failConversationTurn,
  getPool,
  listConversations,
  listCancelRequestedConversationMessages,
  markConversationTurnCancelled,
  registerWorker,
  requestConversationTurnCancellation
} from "@claude-center/db";

async function main(): Promise<void> {
  const pool = getPool();

  // ---- seed：两个 worker、两个项目、各一会话；其中一个会话发了用户消息并被 worker 认领出一条 streaming assistant ----
  await pool.query(`INSERT INTO projects (id, name, repo_url, default_branch) VALUES
    ('00000000-0000-0000-0000-000000000001', 'Alpha Proj', 'https://x/y.git', 'main'),
    ('00000000-0000-0000-0000-000000000002', 'Beta Proj', 'https://x/z.git', 'main')`);

  const workerA = await registerWorker(pool, {
    id: "00000000-0000-0000-0000-00000000aa01",
    name: "worker-alpha",
    hostName: "host-a",
    appVersion: "test",
    capabilities: {},
    metadata: {}
  });
  const workerB = await registerWorker(pool, {
    id: "00000000-0000-0000-0000-00000000bb02",
    name: "worker-beta",
    hostName: "host-b",
    appVersion: "test",
    capabilities: {},
    metadata: {}
  });

  await pool.query(
    `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity, enabled) VALUES
       ($1, '00000000-0000-0000-0000-000000000001', '/tmp/a', 'a.git', true),
       ($2, '00000000-0000-0000-0000-000000000002', '/tmp/b', 'b.git', true)`,
    [workerA.id, workerB.id]
  );

  const conv1 = await createConversation(pool, {
    projectId: "00000000-0000-0000-0000-000000000001",
    workerId: workerA.id,
    branch: "main",
    model: "default",
    title: "调试登录回归",
    createdBy: null
  });
  const conv2 = await createConversation(pool, {
    projectId: "00000000-0000-0000-0000-000000000002",
    workerId: workerB.id,
    branch: "main",
    model: "default",
    title: "整理 API 文档",
    createdBy: null
  });

  // conv1 上发一条 user 消息，让 worker A 认领出 assistant streaming 消息。
  await addConversationMessage(pool, { conversationId: conv1.id, role: "user", body: "复现一下登录失败的链路" });
  const claimed = await claimNextConversationTurn(pool, workerA.id);
  if (!claimed) throw new Error("expected claim to succeed");
  if (claimed.status !== "streaming") throw new Error(`expected streaming, got ${claimed.status}`);

  // ---- 1) 筛选 ----
  const all = await listConversations(pool, { projectIds: null });
  if (all.length !== 2) throw new Error(`expected 2 conversations, got ${all.length}`);

  const byKw = await listConversations(pool, { projectIds: null, keyword: "登录" });
  if (byKw.length !== 1 || byKw[0]!.id !== conv1.id) {
    throw new Error(`keyword filter failed: ${JSON.stringify(byKw.map((c) => c.title))}`);
  }
  const byKwProject = await listConversations(pool, { projectIds: null, keyword: "Beta" });
  if (byKwProject.length !== 1 || byKwProject[0]!.id !== conv2.id) {
    throw new Error(`keyword over project name failed: ${JSON.stringify(byKwProject.map((c) => c.title))}`);
  }
  const byProject = await listConversations(pool, {
    projectIds: null,
    projectId: "00000000-0000-0000-0000-000000000002"
  });
  if (byProject.length !== 1 || byProject[0]!.id !== conv2.id) {
    throw new Error(`projectId filter failed`);
  }
  const byWorker = await listConversations(pool, { projectIds: null, workerId: workerA.id });
  if (byWorker.length !== 1 || byWorker[0]!.id !== conv1.id) {
    throw new Error(`workerId filter failed`);
  }
  const rbacEmpty = await listConversations(pool, { projectIds: [] });
  if (rbacEmpty.length !== 0) throw new Error(`empty projectIds whitelist should yield no rows`);

  // ---- 2) 取消语义 ----
  const cancelTarget = await requestConversationTurnCancellation(pool, conv1.id);
  if (!cancelTarget) throw new Error("requestConversationTurnCancellation returned null");
  if (cancelTarget.id !== claimed.id) throw new Error("cancel target mismatch");
  if (!cancelTarget.cancel_requested_at) throw new Error("cancel_requested_at not set");

  const pending = await listCancelRequestedConversationMessages(pool, workerA.id);
  if (pending.length !== 1 || pending[0]!.id !== claimed.id) {
    throw new Error(`listCancelRequestedConversationMessages mismatch: ${JSON.stringify(pending)}`);
  }
  const noneOnB = await listCancelRequestedConversationMessages(pool, workerB.id);
  if (noneOnB.length !== 0) throw new Error("B worker should see no pending cancels");

  // 错误 worker 不能标记；正确 worker 一次性翻 cancelled；重复 mark 无副作用。
  const wrongOk = await markConversationTurnCancelled(pool, claimed.id, workerB.id);
  if (wrongOk) throw new Error("wrong worker should not flip status");
  const firstOk = await markConversationTurnCancelled(pool, claimed.id, workerA.id);
  if (!firstOk) throw new Error("worker A should flip status");
  const secondOk = await markConversationTurnCancelled(pool, claimed.id, workerA.id);
  if (secondOk) throw new Error("second mark should be no-op (status guard)");

  const after = await pool.query(`SELECT status FROM conversation_messages WHERE id = $1`, [claimed.id]);
  if (after.rows[0]?.status !== "cancelled") throw new Error(`expected cancelled, got ${after.rows[0]?.status}`);

  // ---- 3) failConversationTurn 守卫：已 cancelled 的轮再走 fail 路径不应被覆盖 ----
  await failConversationTurn(pool, { messageId: claimed.id, errorMessage: "should not overwrite" });
  const guarded = await pool.query(
    `SELECT status, error_message FROM conversation_messages WHERE id = $1`,
    [claimed.id]
  );
  if (guarded.rows[0]?.status !== "cancelled") {
    throw new Error(`failConversationTurn overwrote cancelled → ${guarded.rows[0]?.status}`);
  }
  if (guarded.rows[0]?.error_message) {
    throw new Error(`error_message should remain null on cancelled row`);
  }

  // 但仍在 streaming 的消息上 fail 仍能落 failed：补一轮验证。
  await addConversationMessage(pool, { conversationId: conv2.id, role: "user", body: "整理 API" });
  const claimed2 = await claimNextConversationTurn(pool, workerB.id);
  if (!claimed2) throw new Error("claim2 failed");
  await failConversationTurn(pool, { messageId: claimed2.id, errorMessage: "boom" });
  const failed = await pool.query(`SELECT status, error_message FROM conversation_messages WHERE id = $1`, [claimed2.id]);
  if (failed.rows[0]?.status !== "failed") throw new Error(`expected failed, got ${failed.rows[0]?.status}`);
  if (failed.rows[0]?.error_message !== "boom") throw new Error(`error_message not set`);

  await closePool();
  console.log("✓ smoke-conversation-cancel 通过");
}

main().catch((error) => {
  console.error(error);
  void closePool();
  process.exit(1);
});
