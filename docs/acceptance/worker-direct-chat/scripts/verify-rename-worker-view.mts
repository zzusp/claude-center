// 验证「会话改名 + 列表 generating 标 + worker 端会话总览/详情」三块新增数据层。
// 对一次性干净库跑全量迁移 + 新查询往返，零污染共享库（建库 → 迁移 → DROP WITH FORCE）。
// 跑法：node --import tsx docs/acceptance/worker-direct-chat/scripts/verify-rename-worker-view.mts
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  addConversationMessage,
  appendConversationChunk,
  claimNextConversationTurn,
  createConversation,
  finalizeConversationTurn,
  getConversation,
  getConversationChunks,
  listConversationMessages,
  listConversations,
  listWorkerConversations,
  renameConversation
} from "@claude-center/db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

for (let dir = root, i = 0; i < 8; i += 1) {
  const candidate = path.join(dir, ".env");
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseUrl);
const dbName = `cc_dchat_rwv_${Date.now()}`;
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(url);
targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

async function withClient(connUrl: URL, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

// 镜像 runner.getConversationDetail 的流式增量拼装（streaming 的 assistant body 尚空，从 chunks 拼）。
async function assembleDetail(pool: pg.Pool, conversationId: string): Promise<{ role: string; status: string; body: string }[]> {
  const messages = await listConversationMessages(pool, conversationId);
  return Promise.all(
    messages.map(async (m) => {
      if (m.role === "assistant" && m.status === "streaming") {
        const chunks = await getConversationChunks(pool, m.id);
        return { role: m.role, status: m.status, body: chunks.map((c) => c.delta).join("") };
      }
      return { role: m.role, status: m.status, body: m.body };
    })
  );
}

let created = false;
try {
  await withClient(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
  created = true;
  console.log(`✓ created ${dbName}`);

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
    console.log(`✓ applied ${files.length} migrations`);
  });

  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  try {
    const projectId = (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (name, repo_url, default_branch) VALUES ('p','https://x/p','main') RETURNING id`
      )
    ).rows[0]!.id;
    const workerA = (
      await pool.query<{ id: string }>(`INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'wA','hA') RETURNING id`)
    ).rows[0]!.id;
    const workerB = (
      await pool.query<{ id: string }>(`INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'wB','hB') RETURNING id`)
    ).rows[0]!.id;
    const userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, role, display_name) VALUES ('u', crypt('x', gen_salt('bf')), 'admin', 'U') RETURNING id`
      )
    ).rows[0]!.id;
    console.log("✓ seeded project / workerA / workerB / user\n");

    // conv1（workerA）：流式中（有 streaming assistant + chunks）→ generating 应为 true
    const conv1 = await createConversation(pool, { projectId, workerId: workerA, branch: "main", model: "default", title: "原标题", createdBy: userId });
    await addConversationMessage(pool, { conversationId: conv1.id, role: "user", body: "hi" });
    const asst1 = await claimNextConversationTurn(pool, workerA);
    await appendConversationChunk(pool, { messageId: asst1!.id, seq: 0, delta: "abc" });
    await appendConversationChunk(pool, { messageId: asst1!.id, seq: 1, delta: "def" });

    // conv2（workerA）：已答完（done）→ generating 应为 false
    const conv2 = await createConversation(pool, { projectId, workerId: workerA, branch: "main", model: "default", title: "T2", createdBy: userId });
    await addConversationMessage(pool, { conversationId: conv2.id, role: "user", body: "yo" });
    const asst2 = await claimNextConversationTurn(pool, workerA);
    await finalizeConversationTurn(pool, { conversationId: conv2.id, messageId: asst2!.id, body: "done body", sessionId: "s2" });

    // conv3（workerB）：用于验证 worker 隔离
    const conv3 = await createConversation(pool, { projectId, workerId: workerB, branch: "main", model: "default", title: "B", createdBy: userId });
    await addConversationMessage(pool, { conversationId: conv3.id, role: "user", body: "b-hi" });

    // —— 1) 会话改名 ——
    await renameConversation(pool, conv1.id, "新标题");
    assert((await getConversation(pool, conv1.id))?.title === "新标题", "renameConversation → 标题改为「新标题」");
    await renameConversation(pool, conv1.id, "");
    assert((await getConversation(pool, conv1.id))?.title === "", "renameConversation('') → 可清空标题（前端回显「未命名对话」）");

    // —— 2) listConversations 的 generating 派生标 ——
    const all = await listConversations(pool, { projectIds: null });
    const g1 = all.find((c) => c.id === conv1.id);
    const g2 = all.find((c) => c.id === conv2.id);
    assert(g1?.generating === true, "listConversations: 有 streaming assistant 的会话 generating=true");
    assert(g2?.generating === false, "listConversations: 已答完会话 generating=false");

    // —— 3) listWorkerConversations：仅本 worker + 派生标 + last_message_at ——
    const aList = await listWorkerConversations(pool, workerA);
    assert(aList.length === 2, "listWorkerConversations(workerA) → 仅 workerA 的 2 条（不含 workerB）");
    assert(aList.every((c) => c.id !== conv3.id), "listWorkerConversations(workerA) → 不含 workerB 的 conv3");
    assert(aList.find((c) => c.id === conv1.id)?.generating === true, "listWorkerConversations: conv1 generating=true");
    assert(aList.every((c) => c.last_message_at != null), "listWorkerConversations → last_message_at 均有值");
    assert(aList.every((c) => c.project_name === "p" && (c.worker_name === "wA")), "listWorkerConversations → join 出 project_name/worker_name");
    const bList = await listWorkerConversations(pool, workerB);
    assert(bList.length === 1 && bList[0]!.id === conv3.id, "listWorkerConversations(workerB) → 仅 conv3");

    // —— 4) worker 端详情：流式 assistant 从 chunks 拼实时增量 ——
    const detail1 = await assembleDetail(pool, conv1.id);
    const live = detail1.find((m) => m.role === "assistant");
    assert(live?.status === "streaming" && live?.body === "abcdef", "getConversationDetail(流式中) → assistant 实时增量拼为「abcdef」");
    const detail2 = await assembleDetail(pool, conv2.id);
    assert(detail2.find((m) => m.role === "assistant")?.body === "done body", "getConversationDetail(已答完) → assistant 取最终 body");
  } finally {
    await pool.end();
  }
} finally {
  if (created) {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
    console.log(`\n✓ dropped ${dbName}`);
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
