// 任务 token 用量功能的 DB 级验证（零污染：建临时库→迁移→断言→DROP）。
// 证 listTasks 的 sort=tokens 升/降序、与 sort=created 互相区分，且 total_tokens 回 number；
// 证 incrementTaskTokens 在 claimed_by 守卫下逐次累加。
//
// 用法：node docs/acceptance/task-token-usage/scripts/verify-token-sort.mjs
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
const dbName = `cc_token_verify_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
}
const ids = (tasks) => tasks.map((t) => t.title).join(",");

let created = false;
try {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  console.log(`✓ created ${dbName}`);

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
    await c.query("COMMIT");
  });
  console.log(`✓ migrations applied (${(await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).length} files)`);

  // 用临时库跑真实的 db 包函数（getPool 读 DATABASE_URL）。
  process.env.DATABASE_URL = targetUrl.toString();
  const { getPool, listTasks, incrementTaskTokens } = await import("@claude-center/db");
  const pool = getPool();

  // 种子：1 worker + 1 project + 3 tasks（created 与 tokens 故意错位以区分两种排序）。
  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1,'w','h')`, [workerId]);
  const proj = await pool.query(
    `INSERT INTO projects (name, repo_url) VALUES ('p','https://example.com/p.git') RETURNING id`
  );
  const projectId = proj.rows[0].id;

  // [title, created_at, total_tokens]
  const seed = [
    ["t1", "2024-01-01T00:00:00Z", 500],
    ["t2", "2024-01-02T00:00:00Z", 120000],
    ["t3", "2024-01-03T00:00:00Z", 0]
  ];
  for (const [title, createdAt, tokens] of seed) {
    await pool.query(
      `INSERT INTO tasks (project_id, title, description, work_branch, total_tokens, created_at)
       VALUES ($1,$2,'d',$3,$4,$5)`,
      [projectId, title, `cc/${title}`, tokens, createdAt]
    );
  }
  console.log("✓ seeded 3 tasks");

  const list = (sort, dir) => listTasks(pool, { sort, dir, limit: 50, offset: 0 });

  // 1) tokens 排序
  const tokDesc = await list("tokens", "desc");
  assert(ids(tokDesc.tasks) === "t2,t1,t3", `sort=tokens desc → t2,t1,t3（实际 ${ids(tokDesc.tasks)}）`);
  const tokAsc = await list("tokens", "asc");
  assert(ids(tokAsc.tasks) === "t3,t1,t2", `sort=tokens asc → t3,t1,t2（实际 ${ids(tokAsc.tasks)}）`);

  // 2) created 排序（与 tokens 顺序不同，证明两列各自生效）
  const creDesc = await list("created", "desc");
  assert(ids(creDesc.tasks) === "t3,t2,t1", `sort=created desc → t3,t2,t1（实际 ${ids(creDesc.tasks)}）`);
  const creAsc = await list("created", "asc");
  assert(ids(creAsc.tasks) === "t1,t2,t3", `sort=created asc → t1,t2,t3（实际 ${ids(creAsc.tasks)}）`);

  // 3) total_tokens 回 number（pg bigint 默认是字符串，listTasks 须转换）
  const t2 = tokDesc.tasks[0];
  assert(typeof t2.total_tokens === "number", `total_tokens 是 number（实际 ${typeof t2.total_tokens}）`);
  assert(t2.total_tokens === 120000, `t2.total_tokens === 120000（实际 ${t2.total_tokens}）`);

  // 4) incrementTaskTokens：claimed_by 守卫下逐次累加
  const t3Row = await pool.query(`SELECT id FROM tasks WHERE title='t3'`);
  const t3Id = t3Row.rows[0].id;
  await pool.query(`UPDATE tasks SET claimed_by=$2 WHERE id=$1`, [t3Id, workerId]);
  await incrementTaskTokens(pool, t3Id, workerId, 1000);
  await incrementTaskTokens(pool, t3Id, workerId, 250);
  const after = await pool.query(`SELECT total_tokens FROM tasks WHERE id=$1`, [t3Id]);
  assert(Number(after.rows[0].total_tokens) === 1250, `0+1000+250=1250（实际 ${after.rows[0].total_tokens}）`);
  // 守卫：非认领 worker 累加应 no-op
  await incrementTaskTokens(pool, t3Id, randomUUID(), 999);
  const guarded = await pool.query(`SELECT total_tokens FROM tasks WHERE id=$1`, [t3Id]);
  assert(Number(guarded.rows[0].total_tokens) === 1250, `非认领 worker 累加 no-op，仍 1250（实际 ${guarded.rows[0].total_tokens}）`);

  await pool.end();
  console.log("\n✓ 全部断言通过");
} finally {
  if (created) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`✓ dropped ${dbName}`);
  }
}
