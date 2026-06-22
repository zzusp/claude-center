// 实时对话「定时发送 + 自动回复」查询层 e2e：在一次性干净库上直接驱动 @claude-center/db 的真实查询函数，
// 断言核心行为。零污染：建临时库 → 跑全量迁移 → 跑断言 → DROP（--keep 保留）。
//
// 用法：node docs/acceptance/conversation-auto-reply-scheduled/scripts/e2e-queries.mjs [--keep]
// 前置：先 `npm -w @claude-center/db run build`（本脚本 import 编译后的 dist）。
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
const keep = process.argv.includes("--keep");

// 加载最近的 .env（与 packages/db/src/env.ts 一致：不覆盖已有环境变量）。
{
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required（先配 .env）");

const url = new URL(baseUrl);
const dbName = `cc_e2e_conv_${Date.now()}`;
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(url);
targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;

async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

let created = false;
let pool;
try {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  console.log(`✓ created ${dbName}`);

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

  const db = await import("@claude-center/db");
  pool = new pg.Pool({ connectionString: targetUrl.toString() });

  // 种子：项目 + 在线 worker + 启用关联。
  const projectId = (
    await pool.query(
      `INSERT INTO projects (name, repo_url, default_branch) VALUES ('e2e','https://example.com/e2e.git','main') RETURNING id`
    )
  ).rows[0].id;
  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1,'w','h')`, [workerId]);
  await pool.query(
    `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity, enabled) VALUES ($1,$2,'D:/x','id',true)`,
    [workerId, projectId]
  );

  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  // ── 用例 1：自动回复持久化（create 带 autoReply/hints）+ 设置更新（部分字段 COALESCE 不动其余） ──
  const convA = await db.createConversation(pool, {
    projectId,
    workerId,
    branch: "main",
    model: "default",
    title: "A",
    autoReply: true,
    autoDecisionHints: "prefer minimal",
    createdBy: null
  });
  check("1a create 持久化 auto_reply=true", convA.auto_reply === true, `got ${convA.auto_reply}`);
  check("1b create 持久化 auto_decision_hints", convA.auto_decision_hints === "prefer minimal", `got '${convA.auto_decision_hints}'`);
  await db.updateConversationSettings(pool, convA.id, { autoReply: false });
  const convA2 = await db.getConversation(pool, convA.id);
  check("1c update 仅改 auto_reply→false", convA2.auto_reply === false, `got ${convA2.auto_reply}`);
  check("1d update 未传 hints 保持原值（COALESCE）", convA2.auto_decision_hints === "prefer minimal", `got '${convA2.auto_decision_hints}'`);

  // ── 用例 2：即时消息可被认领 ──
  const convB = await db.createConversation(pool, { projectId, workerId, branch: "main", model: "default", title: "B", createdBy: null });
  const msgB = await db.addConversationMessage(pool, { conversationId: convB.id, role: "user", body: "hello" });
  check("2a 即时消息 seq=0", msgB.seq === 0, `got ${msgB.seq}`);
  check("2b 即时消息 status=done", msgB.status === "done", `got ${msgB.status}`);
  const claimB = await db.claimNextConversationTurn(pool, workerId);
  check("2c 即时消息被认领（插入 assistant streaming 轮）", claimB != null && claimB.role === "assistant" && claimB.conversation_id === convB.id);
  // 收尾 B 的在途轮，避免干扰后续「无可认领」断言。
  if (claimB) {
    await db.finalizeConversationTurn(pool, { conversationId: convB.id, messageId: claimB.id, body: "hi", sessionId: "sess-b" });
  }

  // ── 用例 3：定时消息生命周期（未到点不认领 / 不进 prompt → 到点提升 → 可认领 / 进 prompt） ──
  const convC = await db.createConversation(pool, { projectId, workerId, branch: "main", model: "default", title: "C", createdBy: null });
  const schedC = await db.addConversationMessage(pool, { conversationId: convC.id, role: "user", body: "later", scheduledAt: future });
  check("3a 定时消息 seq=NULL", schedC.seq === null, `got ${schedC.seq}`);
  check("3b 定时消息 status=scheduled", schedC.status === "scheduled", `got ${schedC.status}`);
  check("3c 定时消息 scheduled_at 已落", schedC.scheduled_at != null);
  const promptC0 = await db.getConversationPrompt(pool, convC.id);
  check("3d 未到点：getConversationPrompt 不含定时消息（null）", promptC0 === null, `got ${JSON.stringify(promptC0)}`);
  const claimNone = await db.claimNextConversationTurn(pool, workerId);
  check("3e 未到点：无可认领轮（仅定时消息的会话不被认领）", claimNone === null, `got ${JSON.stringify(claimNone)}`);

  // 模拟到点：把该定时消息 scheduled_at 改到过去，再跑调度器提升。
  await pool.query(`UPDATE conversation_messages SET scheduled_at = $2 WHERE id = $1`, [schedC.id, past]);
  const promoted = await db.promoteDueScheduledConversationMessages(pool);
  check("3f 调度器提升到点定时消息（promoted>=1）", promoted >= 1, `got ${promoted}`);
  const rowC = (await pool.query(`SELECT seq, status FROM conversation_messages WHERE id=$1`, [schedC.id])).rows[0];
  check("3g 提升后 status=done", rowC.status === "done", `got ${rowC.status}`);
  check("3h 提升后赋了 seq（非 null）", rowC.seq !== null, `got ${rowC.seq}`);
  const promptC1 = await db.getConversationPrompt(pool, convC.id);
  check("3i 到点后：prompt 含该消息正文", promptC1 === "later", `got ${JSON.stringify(promptC1)}`);
  const claimC = await db.claimNextConversationTurn(pool, workerId);
  check("3j 到点后：定时消息所在会话可被认领", claimC != null && claimC.conversation_id === convC.id);

  // ── 用例 4：同会话多条到点定时消息提升得到互不冲突的连续 seq（无唯一约束冲突） ──
  const convD = await db.createConversation(pool, { projectId, workerId, branch: "main", model: "default", title: "D", createdBy: null });
  const d1 = await db.addConversationMessage(pool, { conversationId: convD.id, role: "user", body: "d1", scheduledAt: past });
  const d2 = await db.addConversationMessage(pool, { conversationId: convD.id, role: "user", body: "d2", scheduledAt: past });
  const promotedD = await db.promoteDueScheduledConversationMessages(pool);
  check("4a 两条到点定时消息均被提升", promotedD === 2, `got ${promotedD}`);
  const seqs = (
    await pool.query(`SELECT seq FROM conversation_messages WHERE id = ANY($1::uuid[]) ORDER BY seq`, [[d1.id, d2.id]])
  ).rows.map((r) => r.seq);
  check("4b 两条 seq 互不相同且非空", seqs.length === 2 && seqs[0] != null && seqs[1] != null && seqs[0] !== seqs[1], `got ${JSON.stringify(seqs)}`);

  // ── 用例 5：取消定时消息（仅 scheduled 可删；已发送的 done 消息不可删） ──
  const convE = await db.createConversation(pool, { projectId, workerId, branch: "main", model: "default", title: "E", createdBy: null });
  const schedE = await db.addConversationMessage(pool, { conversationId: convE.id, role: "user", body: "cancel-me", scheduledAt: future });
  const delOk = await db.deleteScheduledConversationMessage(pool, convE.id, schedE.id);
  check("5a 取消未到点定时消息成功", delOk === true);
  const gone = (await pool.query(`SELECT 1 FROM conversation_messages WHERE id=$1`, [schedE.id])).rowCount;
  check("5b 取消后该消息已删除", gone === 0);
  const doneMsg = await db.addConversationMessage(pool, { conversationId: convE.id, role: "user", body: "normal" });
  const delDone = await db.deleteScheduledConversationMessage(pool, convE.id, doneMsg.id);
  check("5c 已发送（done）消息不可被定时取消删除", delDone === false);

  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
} finally {
  if (pool) await pool.end().catch(() => {});
  if (created && !keep) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`✓ dropped ${dbName}`);
  } else if (keep) {
    console.log(`--keep：保留库 ${dbName}（用完手动 DROP）`);
  }
}

if (fail > 0) process.exitCode = 1;
