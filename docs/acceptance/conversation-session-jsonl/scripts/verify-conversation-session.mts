// 对话存 session jsonl 改造验证：一次性干净库跑全量迁移（含 019）→ 验
//   ① schema：conversation_sessions 表建、conversation_message_chunks 表删
//   ② upsertConversationSession / getConversationSession round-trip（覆盖式 upsert）
//   ③ finalizeConversationTurn 仍写回 body + claude_session_id（与改造后 executor 一致）
//   ④ 删 conversation → conversation_sessions 级联删
//   ⑤ parseTranscript 富解析（thinking / tool_use 保留 input / tool_result 带 tool_use_id 配对）
// 零污染共享库（建库 → 全量迁移 → DROP WITH FORCE），镜像 scripts/ephemeral-db.mjs。
// 跑法：node --import tsx docs/acceptance/conversation-session-jsonl/scripts/verify-conversation-session.mts
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createConversation,
  addConversationMessage,
  claimNextConversationTurn,
  upsertConversationSession,
  getConversationSession,
  finalizeConversationTurn,
  getConversation
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
const dbName = `cc_conv_sess_verify_${Date.now()}`;
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

const SAMPLE = [
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "列出文件" }] } }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看目录" },
        { type: "text", text: "好的，我来列出。" },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }
      ]
    }
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file1\nfile2", is_error: false }] }
  }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "共两个文件。" }] } })
].join("\n");

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
    console.log(`✓ applied ${files.length} migrations (incl. 019_conversation_session_jsonl)\n`);
  });

  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  try {
    const regclass = async (name: string): Promise<boolean> =>
      (await pool.query<{ r: string | null }>(`SELECT to_regclass($1) AS r`, [name])).rows[0]!.r !== null;
    assert(await regclass("conversation_sessions"), "① 019 → conversation_sessions 表存在");
    assert(!(await regclass("conversation_message_chunks")), "① 019 → conversation_message_chunks 表已删");

    const projectId = (
      await pool.query<{ id: string }>(
        `INSERT INTO projects (name, repo_url, default_branch) VALUES ('p','https://x/p','main') RETURNING id`
      )
    ).rows[0]!.id;
    const workerId = (
      await pool.query<{ id: string }>(`INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'w','h') RETURNING id`)
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

    const conv = await createConversation(pool, {
      projectId,
      workerId,
      branch: "main",
      model: "default",
      title: "t",
      createdBy: userId
    });
    await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "列出文件" });
    const asst = await claimNextConversationTurn(pool, workerId);
    assert(asst?.status === "streaming", "claimNextConversationTurn → assistant streaming");

    // ② 覆盖式 upsert：先写 {}，再写 SAMPLE，应拿到最新
    await upsertConversationSession(pool, conv.id, "{}");
    await upsertConversationSession(pool, conv.id, SAMPLE);
    const sess = await getConversationSession(pool, conv.id);
    assert(sess?.jsonl === SAMPLE, "② upsert→getConversationSession round-trip（覆盖式 upsert 拿到最新 jsonl）");
    assert(sess?.synced_at != null, "② getConversationSession 带 synced_at");

    // ③ finalize 仍写 body + session
    await finalizeConversationTurn(pool, { conversationId: conv.id, messageId: asst!.id, body: "共两个文件。", sessionId: "sess-x" });
    assert((await getConversation(pool, conv.id))?.claude_session_id === "sess-x", "③ finalizeConversationTurn → 写回 claude_session_id");

    // ④ 级联删
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [conv.id]);
    assert((await getConversationSession(pool, conv.id)) === null, "④ 删 conversation → conversation_sessions 级联删");

    // ⑤ parseTranscript 富解析（dynamic import 避免 react-markdown ESM 拖垮上面的 DB 验证）
    try {
      const mod = (await import("../../../../apps/console/app/ui/transcript")) as {
        parseTranscript: (j: string) => Array<{ role: string; blocks: Array<Record<string, unknown>> }>;
      };
      const items = mod.parseTranscript(SAMPLE);
      assert(items.length === 4, `⑤ parseTranscript → 4 条消息（实际 ${items.length}）`);
      const a1 = items[1];
      assert(a1?.role === "assistant" && a1.blocks.some((b) => b.kind === "thinking"), "⑤ 解析出 assistant thinking 块");
      const tu = a1?.blocks.find((b) => b.kind === "tool_use") as { name?: string; input?: { command?: string } } | undefined;
      assert(tu?.name === "Bash" && tu?.input?.command === "ls -la", "⑤ tool_use 保留原始 input.command");
      const tr = items[2]?.blocks.find((b) => b.kind === "tool_result") as { toolUseId?: string; text?: string } | undefined;
      assert(tr?.toolUseId === "tu_1" && Boolean(tr?.text?.includes("file1")), "⑤ tool_result 带 tool_use_id 配对");
    } catch (e) {
      failures += 1;
      console.error(`  FAIL  ⑤ parseTranscript import/run 失败：${e instanceof Error ? e.message : String(e)}`);
    }
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

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
