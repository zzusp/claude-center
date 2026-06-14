// P0 数据层验证：对一次性干净库跑迁移链（含 017_conversations）+ 全套 conversation 查询函数往返。
// 零污染共享库（建库 → 全量迁移 → DROP WITH FORCE），镜像 scripts/ephemeral-db.mjs 的建/迁/删。
// 跑法：node --import tsx docs/acceptance/worker-direct-chat/scripts/verify-data-layer.mts
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createConversation,
  addConversationMessage,
  claimNextConversationTurn,
  getConversationPrompt,
  appendConversationChunk,
  getConversationChunks,
  finalizeConversationTurn,
  failConversationTurn,
  closeConversation,
  getConversation,
  listConversations,
  listConversationMessages,
  getConversationLocalPath
} from "@claude-center/db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// 加载 .env（不覆盖已有 env）
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
const dbName = `cc_dchat_verify_${Date.now()}`;
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

let created = false;
try {
  await withClient(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
  created = true;
  console.log(`✓ created ${dbName}`);

  // 全量迁移（单事务）
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
    console.log(`✓ applied ${files.length} migrations (incl. 017_conversations)`);
  });

  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  try {
    // 种子：项目 / worker / 关联 / 用户
    const projectId = (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (name, repo_url, default_branch) VALUES ('p','https://x/p','main') RETURNING id`
      )
    ).rows[0]!.id;
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'w','h') RETURNING id`
      )
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity) VALUES ($1,$2,'D:/repos/p','p')`,
      [workerId, projectId]
    );
    const userId = (
      await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, role, display_name) VALUES ('u', crypt('x', gen_salt('bf')), 'admin', 'U') RETURNING id`
      )
    ).rows[0]!.id;
    console.log("✓ seeded project/worker/link/user\n");

    // 1) 建会话
    const conv = await createConversation(pool, {
      projectId,
      workerId,
      branch: "main",
      model: "default",
      title: "测试对话",
      createdBy: userId
    });
    assert(conv.id && conv.status === "active" && conv.worker_id === workerId, "createConversation → active 会话指向该 worker");

    // 2) 用户提问
    const userMsg = await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "你好" });
    assert(userMsg.role === "user" && userMsg.seq === 0 && userMsg.status === "done", "addConversationMessage(user) seq=0 done");

    // 3) 本轮提问拼接
    assert((await getConversationPrompt(pool, conv.id)) === "你好", "getConversationPrompt → '你好'");

    // 4) Worker 认领（错的 worker 领不到）
    assert((await claimNextConversationTurn(pool, (await pool.query<{ id: string }>(`SELECT gen_random_uuid() id`)).rows[0]!.id)) === null, "claimNextConversationTurn(别的 worker) → null");
    const asst = await claimNextConversationTurn(pool, workerId);
    assert(asst !== null && asst.role === "assistant" && asst.status === "streaming" && asst.seq === 1, "claimNextConversationTurn → assistant streaming seq=1");

    // 5) 已有在途 assistant，重复领取应为 null（防并发重复应答）
    assert((await claimNextConversationTurn(pool, workerId)) === null, "claim 时已有 streaming → 再领 null");

    // 6) 流式分片
    await appendConversationChunk(pool, { messageId: asst!.id, seq: 0, delta: "你" });
    await appendConversationChunk(pool, { messageId: asst!.id, seq: 1, delta: "好呀" });
    const chunks = await getConversationChunks(pool, asst!.id);
    assert(chunks.length === 2 && chunks.map((x) => x.delta).join("") === "你好呀", "getConversationChunks 拼回 '你好呀'");
    assert((await getConversationChunks(pool, asst!.id, 0)).length === 1, "getConversationChunks(afterSeq=0) → 续传 1 片");

    // 7) 收尾：落全文 + done + session
    await finalizeConversationTurn(pool, { conversationId: conv.id, messageId: asst!.id, body: "你好呀", sessionId: "sess-1" });
    const after = await getConversation(pool, conv.id);
    assert(after?.claude_session_id === "sess-1", "finalize → 会话写回 claude_session_id");
    const msgs1 = await listConversationMessages(pool, conv.id);
    assert(
      msgs1.length === 2 && msgs1[1]!.status === "done" && msgs1[1]!.body === "你好呀",
      "listConversationMessages → assistant done body='你好呀'"
    );

    // 8) 收尾后无未答轮，领取 null
    assert((await claimNextConversationTurn(pool, workerId)) === null, "已答完 → 领取 null");

    // 9) 第二轮：再提问 → prompt 只含新问题（不含已答的旧问题）
    await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "第二个问题" });
    assert((await getConversationPrompt(pool, conv.id)) === "第二个问题", "第二轮 getConversationPrompt 只含新问题");
    const asst2 = await claimNextConversationTurn(pool, workerId);
    assert(asst2 !== null && asst2.seq === 3, "第二轮 claim → assistant seq=3");
    // 失败收尾
    await failConversationTurn(pool, { messageId: asst2!.id, errorMessage: "boom" });
    const msgs2 = await listConversationMessages(pool, conv.id);
    assert(msgs2[3]!.status === "failed" && msgs2[3]!.error_message === "boom", "failConversationTurn → failed + error_message");
    // 失败轮是终态：不自动重试（避免持久失败死循环），需用户再发一条消息才重答
    assert((await claimNextConversationTurn(pool, workerId)) === null, "失败轮终态 → 直接再领 null（不自动重试）");
    await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "重试一下" });
    const retry = await claimNextConversationTurn(pool, workerId);
    assert(retry !== null && retry.seq === 5, "用户再发消息后 → 可领取新轮 seq=5");
    await finalizeConversationTurn(pool, { conversationId: conv.id, messageId: retry!.id, body: "好的", sessionId: null });

    // 10) RBAC 过滤 + 本地路径解析
    assert((await listConversations(pool, { projectIds: [projectId] })).length === 1, "listConversations(有权项目) → 1 条");
    assert((await listConversations(pool, { projectIds: [] })).length === 0, "listConversations(空白名单) → 0 条");
    assert((await listConversations(pool, { projectIds: null })).length === 1, "listConversations(admin/null) → 1 条");
    assert((await getConversationLocalPath(pool, conv.id, workerId)) === "D:/repos/p", "getConversationLocalPath → 'D:/repos/p'");

    // 11) 关闭会话后不再可领
    await closeConversation(pool, conv.id);
    assert((await getConversation(pool, conv.id))?.status === "closed", "closeConversation → status closed");
    await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "关了还能聊吗" });
    assert((await claimNextConversationTurn(pool, workerId)) === null, "closed 会话 → 不再领取");
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
