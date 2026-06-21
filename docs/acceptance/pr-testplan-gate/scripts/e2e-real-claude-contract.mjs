// 真·端到端（真实 claude）：验证 center-rules.md 的产出契约——真实模型完成任务后，最终产出（被 Worker
// 用作 PR body 的 tasks.result.claudeResult）确实是结构化 PR 描述，含 ## Summary / ## Changes / ## Test Plan
// 及 checkbox。走完整产品入口 executeTask（真实 claude），submit_mode='push'（不需要 gh）。
// 需要本机 claude 可用（PATH 上有 claude）。零污染：临时 PG 库 + 临时本地 git 仓，结束清理。
// 用法：node docs/acceptance/pr-testplan-gate/scripts/e2e-real-claude-contract.mjs
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
{
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    const c = path.join(dir, ".env");
    if (existsSync(c)) { process.loadEnvFile(c); break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required（先配 .env）");

const url = new URL(baseUrl);
const dbName = `cc_contract_e2e_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}
let failures = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failures++; console.log(`  ✗ ${msg}`); } };

let created = false, tmpRoot = null, pool = null;
try {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cc-contract-e2e-"));
  const seed = path.join(tmpRoot, "seed");
  const bare = path.join(tmpRoot, "origin.git");
  const checkout = path.join(tmpRoot, "checkout");
  git(["init", "-b", "main", seed]);
  git(["config", "user.email", "e2e@example.com"], seed);
  git(["config", "user.name", "e2e"], seed);
  await writeFile(path.join(seed, "README.md"), "# seed\n", "utf8");
  git(["add", "-A"], seed); git(["commit", "-m", "init"], seed);
  git(["init", "--bare", "-b", "main", bare]);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", bare, checkout]);
  git(["config", "user.email", "worker@example.com"], checkout);
  git(["config", "user.name", "worker"], checkout);
  git(["config", "commit.gpgsign", "false"], checkout);

  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) await c.query(await readFile(path.join(migrationsDir, f), "utf8"));
    await c.query("COMMIT");
  });
  console.log(`✓ 临时库迁移完成：${dbName}`);

  process.env.DATABASE_URL = targetUrl.toString();
  const db = await import("@claude-center/db");
  db.setDatabaseUrl(targetUrl.toString());
  pool = db.getPool();
  const { executeTask } = await import(pathToFileURL(path.join(root, "apps", "worker", "dist", "executor.js")).href);

  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1,'e2e-worker','e2e-host')`, [workerId]);
  const project = await db.createProject(pool, { name: `e2e-${Date.now()}`, repoUrl: bare, defaultBranch: "main", description: "contract e2e" });
  await db.upsertWorkerProjectLink(pool, { workerId, projectName: project.name, repoUrl: bare, localPath: checkout });
  const projectRepoId = (await pool.query(`SELECT id FROM project_repos WHERE project_id=$1 AND role='main'`, [project.id])).rows[0].id;

  const workBranch = `cc/contract-${Date.now()}`;
  const draft = await db.createTask(pool, {
    projectId: project.id, title: "contract e2e",
    description: "在仓库根目录新建文件 HELLO.md，写入一行：hello world。只做这一个改动，不要运行 git，完成后结束。",
    baseBranch: "main", workBranch, targetBranch: "main", submitMode: "push",
    autoMergePr: false, autoReply: false, autoDecisionHints: "", model: "default", dynamicWorkflow: false
  });
  await db.createTaskRepos(pool, draft.id, [{ projectRepoId, role: "main", relativePath: ".", baseBranch: "main", workBranch, targetBranch: "main", subStatus: "pending" }]);
  await pool.query(`UPDATE tasks SET status='claimed', claimed_by=$2, claimed_at=now() WHERE id=$1`, [draft.id, workerId]);
  const task = (await pool.query(`SELECT * FROM tasks WHERE id=$1`, [draft.id])).rows[0];

  const config = {
    workerId, workerName: "e2e", hostName: "e2e", appVersion: "0.1.0",
    databaseUrl: targetUrl.toString(), projects: [], pollIntervalMs: 10000, heartbeatIntervalMs: 15000,
    claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude", claudePreCommand: "", terminalCommand: "", ghCommand: "gh",
    permissionMode: process.env.CLAUDE_CENTER_PERMISSION_MODE || "bypassPermissions",
    claudeSettingsPath: path.join(root, "apps", "worker", "config", "claude-settings.json"),
    claudeRulesPath: path.join(root, "apps", "worker", "prompts", "center-rules.md"),
    dataDir: path.join(tmpRoot, "data"), maxParallel: 1, allowRemoteControl: false,
    usageProxy: null, infoIntervalMs: 60000, usageIntervalMs: 300000, relayUrl: "", relayPublishToken: "", relayWorkerToken: ""
  };

  console.log("✓ 开始真实执行 claude（数十秒）…\n");
  const t0 = Date.now();
  await executeTask(config, task, { claudeAvailable: true });
  console.log(`✓ executeTask 返回（${Math.round((Date.now() - t0) / 1000)}s）\n`);

  const row = (await pool.query(`SELECT status, error_message, result->>'claudeResult' AS claude_result FROM tasks WHERE id=$1`, [task.id])).rows[0];
  const cr = row.claude_result ?? "";
  console.log(`  任务终态：status=${row.status}, error=${row.error_message ?? "—"}`);
  console.log("  ---- claudeResult（PR body 主体）----");
  console.log(cr.split(/\r?\n/).map((l) => "  | " + l).join("\n"));
  console.log("  -------------------------------------");

  assert(["success", "merged"].includes(row.status), `任务完成（status=${row.status}）`);
  assert(/##\s*Summary/i.test(cr), "claudeResult 含 ## Summary");
  assert(/##\s*Changes/i.test(cr), "claudeResult 含 ## Changes");
  assert(/##\s*Test Plan/i.test(cr), "claudeResult 含 ## Test Plan");
  assert(/^\s*[-*]\s*\[[ xX]\]/m.test(cr), "claudeResult 含 GitHub checkbox 任务项");
  assert(!cr.includes("```text"), "claudeResult 自身不是 ```text 代码块");

  console.log(failures === 0 ? "\n✓ 真实模型产出契约验证通过" : `\n✗ ${failures} 条断言失败`);
} finally {
  if (pool) await pool.end().catch(() => {});
  if (created) { await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(() => {}); console.log(`✓ dropped ${dbName}`); }
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
