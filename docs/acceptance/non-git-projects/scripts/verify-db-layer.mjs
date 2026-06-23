// 非 git 项目 DB 层端到端验证（零污染：自建临时库 → 跑全量迁移 → 断言 → DROP）。
// 覆盖：createProject(vcs=none) 不建 project_repos、createTask 空分支、listTaskRepos 为空、
//       createConversation 空 branch、upsertWorkerProjectLink 的 repo_identity 兜底为项目名。
// 用法：node docs/acceptance/non-git-projects/scripts/verify-db-layer.mjs
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "@claude-center/db";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");

// 加载最近的 .env（向上找，不覆盖已有 env）。
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
const dbName = `cc_nongit_verify_${Date.now()}`;
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
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}`);
  }
}

let created = false;
try {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
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
  });
  console.log("✓ migrations applied\n");

  db.setDatabaseUrl(targetUrl.toString());
  const pool = db.getPool();

  // —— schema：projects.repo_url 可空 + vcs 列存在 ——
  const cols = await pool.query(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name='projects' AND column_name IN ('repo_url','vcs')`
  );
  const repoCol = cols.rows.find((r) => r.column_name === "repo_url");
  const vcsCol = cols.rows.find((r) => r.column_name === "vcs");
  check("projects.repo_url 可空", repoCol?.is_nullable === "YES");
  check("projects.vcs 列存在", Boolean(vcsCol));

  // —— 非 git 项目：repo_url=null、vcs=none、不建 project_repos 主仓行 ——
  const ng = await db.createProject(pool, { name: "NG", repoUrl: null, defaultBranch: "", description: "", vcs: "none" });
  check("非 git 项目 vcs=none", ng.vcs === "none");
  check("非 git 项目 repo_url=null", ng.repo_url === null);
  const ngRepos = await db.listProjectRepos(pool, ng.id);
  check("非 git 项目无 project_repos 行", ngRepos.length === 0);

  // —— git 项目：仍自动建主仓行 ——
  const g = await db.createProject(pool, {
    name: "G",
    repoUrl: "https://github.com/acme/g.git",
    defaultBranch: "main",
    description: "",
    vcs: "git"
  });
  const gRepos = await db.listProjectRepos(pool, g.id);
  check("git 项目自动建主仓 project_repos 行", gRepos.length === 1 && gRepos[0].role === "main");

  // —— 非 git 任务：空分支、不建 task_repos（复刻 route 逻辑）——
  const t = await db.createTask(pool, {
    projectId: ng.id,
    title: "t",
    description: "d",
    baseBranch: "",
    workBranch: "",
    targetBranch: "",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false
  });
  check("非 git 任务 work_branch 为空", t.work_branch === "");
  const trepos = await db.listTaskRepos(pool, t.id);
  check("非 git 任务无 task_repos 行", trepos.length === 0);

  // —— worker + 非 git 关联：repo_identity 兜底为项目名（不 NOT NULL 违例）——
  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1, 'w', 'h')`, [workerId]);
  await db.upsertWorkerProjectLink(pool, { workerId, projectName: "NG", localPath: "D:/ng" });
  const link = await pool.query(
    `SELECT repo_identity FROM worker_project_links WHERE worker_id=$1 AND project_id=$2`,
    [workerId, ng.id]
  );
  check("非 git 关联 repo_identity 兜底为项目名", link.rows[0]?.repo_identity === "NG");

  // —— 非 git 对话：空 branch 可建 ——
  const conv = await db.createConversation(pool, {
    projectId: ng.id,
    workerId,
    branch: "",
    model: "default",
    createdBy: null
  });
  check("非 git 对话 branch 为空", conv.branch === "");

  await db.closePool();
  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
} finally {
  if (created) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`✓ dropped ${dbName}`);
  }
}

process.exit(fail === 0 ? 0 : 1);
