// 真·端到端：用真实 claude CLI 跑一个真实任务，证 token 用量被解析并累加进 tasks.total_tokens、
// 任务正常走到 success。零污染：临时 PG 库 + 临时本地 git 仓（bare origin + clone），结束 DROP + 删目录。
//
// 走的就是产品代码路径：apps/worker/dist/executor.js 的 executeTask → spawnClaude（真 claude）
//   → runTaskClaude → parseClaudeJson 解析 usage → sumUsageTokens → incrementTaskTokens 落库
//   → finalize commit/push origin（本地 bare 仓）→ markTaskSuccess。
//
// 用法：node docs/acceptance/task-token-usage/scripts/e2e-executor.mjs
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");

// 加载最近的 .env（不覆盖已有环境变量）。
{
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) { process.loadEnvFile(candidate); break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required（先配 .env）");

const url = new URL(baseUrl);
const dbName = `cc_token_e2e_${Date.now()}`;
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
function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}

let created = false;
let tmpRoot = null;
let pool = null;
try {
  // ---- A) 临时本地 git 仓：bare origin + 带初始 main 提交的 clone ----
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cc-token-e2e-"));
  const seed = path.join(tmpRoot, "seed");
  const bare = path.join(tmpRoot, "origin.git");
  const checkout = path.join(tmpRoot, "checkout");
  git(["init", "-b", "main", seed]);
  git(["config", "user.email", "e2e@example.com"], seed);
  git(["config", "user.name", "e2e"], seed);
  await writeFile(path.join(seed, "README.md"), "# e2e seed\n", "utf8");
  git(["add", "-A"], seed);
  git(["commit", "-m", "init"], seed);
  git(["init", "--bare", "-b", "main", bare]);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", bare, checkout]);
  // worktree 提交身份（linked worktree 共享主仓 .git/config）；禁签名避免本机 gpg 阻塞。
  git(["config", "user.email", "worker@example.com"], checkout);
  git(["config", "user.name", "worker"], checkout);
  git(["config", "commit.gpgsign", "false"], checkout);
  console.log(`✓ 本地仓就绪：${tmpRoot}`);

  // ---- B) 临时 PG 库 + 全量迁移 ----
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
    await c.query("COMMIT");
  });
  console.log(`✓ 临时库迁移完成：${dbName}`);

  // ---- C) 让 db 包指向临时库，再 import 产品代码 ----
  process.env.DATABASE_URL = targetUrl.toString();
  const db = await import("@claude-center/db");
  db.setDatabaseUrl(targetUrl.toString());
  pool = db.getPool();
  const { executeTask } = await import(pathToFileURL(path.join(root, "apps", "worker", "dist", "executor.js")).href);

  // ---- D) 种子 DB：worker / project / link / task / task_repos ----
  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1,'e2e-worker','e2e-host')`, [workerId]);
  const project = await db.createProject(pool, {
    name: `e2e-${Date.now()}`, repoUrl: bare, defaultBranch: "main", description: "token e2e"
  });
  await db.upsertWorkerProjectLink(pool, { workerId, projectName: project.name, repoUrl: bare, localPath: checkout });
  const repoRow = await pool.query(`SELECT id FROM project_repos WHERE project_id=$1 AND role='main'`, [project.id]);
  const projectRepoId = repoRow.rows[0].id;

  const workBranch = `cc/e2e-${Date.now()}`;
  const draft = await db.createTask(pool, {
    projectId: project.id, title: "token e2e", description:
      "在仓库根目录新建文件 E2E.md，写入一行文本：token e2e ok。只做这一个改动，不要运行 git，不要创建其它文件，完成后结束。",
    baseBranch: "main", workBranch, targetBranch: "main", submitMode: "push",
    autoMergePr: false, autoReply: false, autoDecisionHints: "", model: "default", dynamicWorkflow: false
  });
  await db.createTaskRepos(pool, draft.id, [{
    projectRepoId, role: "main", relativePath: ".",
    baseBranch: "main", workBranch, targetBranch: "main", subStatus: "pending"
  }]);
  // 模拟「已认领」：executeTask 的 markTaskRunning 以 claimed_by 为守卫。
  await pool.query(
    `UPDATE tasks SET status='claimed', claimed_by=$2, claimed_at=now() WHERE id=$1`,
    [draft.id, workerId]
  );
  const taskRow = await pool.query(`SELECT * FROM tasks WHERE id=$1`, [draft.id]);
  const task = taskRow.rows[0];
  console.log("✓ 种子完成，开始真实执行 claude（可能耗时数十秒）…\n");

  // ---- E) 真实执行（产品入口） ----
  const config = {
    workerId, workerName: "e2e", hostName: "e2e", appVersion: "0.1.0",
    databaseUrl: targetUrl.toString(), projects: [],
    pollIntervalMs: 10000, heartbeatIntervalMs: 15000,
    claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude",
    claudePreCommand: "", terminalCommand: "", ghCommand: "gh",
    permissionMode: process.env.CLAUDE_CENTER_PERMISSION_MODE || "bypassPermissions",
    claudeSettingsPath: path.join(root, "apps", "worker", "config", "claude-settings.json"),
    claudeRulesPath: path.join(root, "apps", "worker", "prompts", "center-rules.md"),
    dataDir: path.join(tmpRoot, "data"), maxParallel: 1, allowRemoteControl: false,
    usageProxy: null, infoIntervalMs: 60000, usageIntervalMs: 300000,
    relayUrl: "", relayPublishToken: "", relayWorkerToken: ""
  };
  const t0 = Date.now();
  await executeTask(config, task, { claudeAvailable: true });
  console.log(`\n✓ executeTask 返回（${Math.round((Date.now() - t0) / 1000)}s）\n`);

  // ---- F) 断言 ----
  const after = await pool.query(`SELECT status, total_tokens, error_message FROM tasks WHERE id=$1`, [task.id]);
  const row = after.rows[0];
  console.log(`  任务终态：status=${row.status}, total_tokens=${row.total_tokens}, error=${row.error_message ?? "—"}`);
  const events = await pool.query(
    `SELECT event_type FROM task_events WHERE task_id=$1 ORDER BY created_at`, [task.id]
  );
  const evTypes = events.rows.map((e) => e.event_type);
  console.log(`  事件时间线：${evTypes.join(" → ")}`);

  assert(Number(row.total_tokens) > 0, `total_tokens 已记录且 > 0（实际 ${row.total_tokens}）`);
  assert(row.status === "success", `任务走到 success（实际 ${row.status}${row.error_message ? "：" + row.error_message : ""}）`);
  assert(evTypes.includes("claude_turn_finished"), "事件含 claude_turn_finished（claude 真跑过一轮）");
  assert(evTypes.includes("pushed"), "事件含 pushed（改动已直推 origin）");

  // listTasks 也应带回 number 型 total_tokens（列表/排序消费的形态）
  const listed = await db.listTasks(pool, { sort: "tokens", dir: "desc", limit: 10, offset: 0 });
  const me = listed.tasks.find((t) => t.id === task.id);
  assert(me && typeof me.total_tokens === "number" && me.total_tokens > 0,
    `listTasks 返回 number 型 total_tokens=${me?.total_tokens}`);

  // 确认改动真落到了 origin（bare 仓 main 顶部提交是 ClaudeCenter 的）
  const top = git(["--git-dir", bare, "log", "-1", "--pretty=%s", "main"]).trim();
  assert(top.startsWith("ClaudeCenter task:"), `origin/main 顶部提交来自 worker（"${top}"）`);
  const tree = git(["--git-dir", bare, "ls-tree", "--name-only", "main"]);
  assert(tree.split(/\r?\n/).includes("E2E.md"), "origin/main 含 claude 新建的 E2E.md");

  console.log("\n✓ 端到端全部断言通过");
} finally {
  if (pool) await pool.end().catch(() => {});
  if (created) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(() => {});
    console.log(`✓ dropped ${dbName}`);
  }
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}
