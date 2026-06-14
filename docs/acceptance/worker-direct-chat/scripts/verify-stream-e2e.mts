// P1 真 claude 流式端到端：seed 临时库 + 本地 bare origin/clone（免网络），驱动 executeConversationTurn
// 跑真 claude --output-format stream-json，断言：① 流式分片落库 ② 最终 body + status done ③ session_id
// ④ 只读（origin/main 无新提交）。需代理跑 claude：HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:10808（脚本设）。
// 跑法：npx tsx docs/acceptance/worker-direct-chat/scripts/verify-stream-e2e.mts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import {
  closePool,
  createConversation,
  addConversationMessage,
  claimNextConversationTurn,
  getConversation,
  getConversationChunks,
  listConversationMessages
} from "@claude-center/db";
import { executeConversationTurn } from "../../../../apps/worker/src/executor.ts";
import { conversationWorktreePathFor } from "../../../../apps/worker/src/worktree.ts";
import type { WorkerConfig } from "../../../../apps/worker/src/config.ts";

// 跑 claude 必须走代理（不覆盖已设值）
process.env.HTTP_PROXY ||= "http://127.0.0.1:10808";
process.env.HTTPS_PROXY ||= "http://127.0.0.1:10808";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const tmp = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, "tmp") : path.join(root, ".tmp-e2e");
const stamp = String(process.hrtime.bigint());
const originDir = path.join(tmp, `dc-origin-${stamp}.git`);
const localDir = path.join(tmp, `dc-local-${stamp}`);
const dataDir = path.join(tmp, `dc-data-${stamp}`);

for (let dir = root, i = 0; i < 8; i += 1) {
  const c = path.join(dir, ".env");
  if (existsSync(c)) { process.loadEnvFile(c); break; }
  const p = path.dirname(dir); if (p === dir) break; dir = p;
}
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL required");
const url = new URL(baseUrl);
const dbName = `cc_dchat_e2e_${stamp}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

let failures = 0;
const assert = (cond: unknown, msg: string) => {
  if (cond) console.log(`  PASS  ${msg}`);
  else { failures += 1; console.error(`  FAIL  ${msg}`); }
};
const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const withClient = async (u: URL, fn: (c: pg.Client) => Promise<void>) => {
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try { await fn(c); } finally { await c.end(); }
};

let created = false;
try {
  // 本地 git：bare origin + clone，提交一次推到 origin/main（全程本地、免网络）
  mkdirSync(tmp, { recursive: true });
  git(["init", "--bare", "-b", "main", originDir]);
  git(["clone", originDir, localDir]);
  writeFileSync(path.join(localDir, "README.md"), "# direct-chat e2e fixture\n");
  git(["-c", "user.email=ci@x", "-c", "user.name=ci", "-C", localDir, "add", "."]);
  git(["-c", "user.email=ci@x", "-c", "user.name=ci", "-C", localDir, "commit", "-m", "seed"]);
  git(["-C", localDir, "push", "-u", "origin", "main"]);
  const originHeadBefore = git(["-C", localDir, "rev-parse", "origin/main"]);
  console.log("✓ local git origin + clone ready");

  // 临时库 + 全量迁移
  await withClient(adminUrl, async (c) => { await c.query(`CREATE DATABASE "${dbName}"`); });
  created = true;
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const f of files) { await c.query(await readFile(path.join(migrationsDir, f), "utf8")); await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]); }
    await c.query("COMMIT");
  });
  console.log("✓ ephemeral db migrated");

  // executeConversationTurn 内部用 db 包的 getPool() 单例（读 DATABASE_URL）。指到临时库，
  // 否则它会打到共享 dev 库（无 017 的表）。必须在首次 getPool() 之前设置。
  process.env.DATABASE_URL = targetUrl.toString();

  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  try {
    const projectId = (await pool.query<{ id: string }>(`INSERT INTO projects (name, repo_url, default_branch) VALUES ('p', $1, 'main') RETURNING id`, [originDir])).rows[0]!.id;
    const workerId = (await pool.query<{ id: string }>(`INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'w','h') RETURNING id`)).rows[0]!.id;
    await pool.query(`INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity) VALUES ($1,$2,$3,'p')`, [workerId, projectId, localDir]);

    const config = {
      workerId,
      claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude",
      dataDir,
      claudePreCommand: "",
      terminalCommand: ""
    } as unknown as WorkerConfig;

    const conv = await createConversation(pool, { projectId, workerId, branch: "main", model: "default", title: "e2e", createdBy: null });
    await addConversationMessage(pool, { conversationId: conv.id, role: "user", body: "Reply with exactly the single word: hello — nothing else." });
    const turn = await claimNextConversationTurn(pool, workerId);
    assert(turn !== null && turn.status === "streaming", "认领到 assistant streaming 轮");

    console.log("  … 跑真 claude 流式（经代理），稍候");
    await executeConversationTurn(config, conv, turn!);

    const chunks = await getConversationChunks(pool, turn!.id);
    const msgs = await listConversationMessages(pool, conv.id);
    const asst = msgs.find((m) => m.id === turn!.id)!;
    if (asst.status !== "done") console.error(`  [diag] assistant status=${asst.status} error=${asst.error_message}`);
    assert(chunks.length >= 1, `流式分片落库 (${chunks.length} 片)`);
    assert(asst.status === "done", "assistant 消息 status=done");
    assert(asst.body.trim().length > 0, `最终 body 非空: ${JSON.stringify(asst.body.slice(0, 40))}`);
    assert(chunks.map((c) => c.delta).join("") === asst.body || asst.body.includes(chunks.map((c) => c.delta).join("").trim()), "分片拼接与最终 body 一致");
    const after = await getConversation(pool, conv.id);
    assert(!!after?.claude_session_id, `会话写回 claude_session_id: ${after?.claude_session_id?.slice(0, 8)}`);

    const wtPath = conversationWorktreePathFor(config, conv.id);
    assert(existsSync(path.join(wtPath, ".git")), "只读工作树已创建");
    const originHeadAfter = git(["-C", localDir, "rev-parse", "origin/main"]);
    assert(originHeadAfter === originHeadBefore, "只读：origin/main 无新提交");

    // 清理工作树
    try { git(["-C", localDir, "worktree", "remove", "--force", wtPath]); } catch { /* ignore */ }
  } finally {
    await pool.end();
  }
} finally {
  // 关掉 db 包 getPool() 单例池，否则 DROP ... WITH (FORCE) 会强杀其空闲连接 → 池抛未处理 error。
  try { await closePool(); } catch { /* ignore */ }
  if (created) await withClient(adminUrl, async (c) => { await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); });
  for (const d of [originDir, localDir, dataDir]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  console.log("✓ cleaned up");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
