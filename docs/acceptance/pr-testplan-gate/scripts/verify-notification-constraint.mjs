// 验证迁移 035：notifications.type 的 CHECK 约束接受 task_review_required、拒绝未知值。
// 零污染：建一次性临时库 → 跑全量迁移 → 断言 → DROP（镜像 scripts/ephemeral-db.mjs）。
// 跑：node docs/acceptance/pr-testplan-gate/scripts/verify-notification-constraint.mjs
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");

// 加载最近的 .env（向上找，不覆盖已有环境变量）——与 ephemeral-db.mjs 一致。
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
if (!baseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseUrl);
const dbName = `cc_constraint_check_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

let created = false;
let failures = 0;
const log = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

try {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");

    // 1) 约束定义含全部 8 个类型
    const def = (await c.query(
      "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'notifications_type_check'"
    )).rows[0]?.d ?? "";
    const expected = [
      "task_claimed", "task_waiting", "task_success", "task_failed",
      "task_pr_created", "task_review_required", "worker_online", "worker_offline"
    ];
    log(Boolean(def), `约束 notifications_type_check 存在`);
    for (const t of expected) log(def.includes(t), `约束含类型 ${t}`);

    // 2) 真插入：用引导 admin 的 id 满足 FK
    const userId = (await c.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1")).rows[0]?.id;
    log(Boolean(userId), `引导 admin 用户存在（FK 用）`);

    try {
      await c.query(
        "INSERT INTO notifications (user_id, type, title) VALUES ($1, 'task_review_required', 't')",
        [userId]
      );
      log(true, `INSERT type=task_review_required 成功`);
    } catch (e) {
      log(false, `INSERT type=task_review_required 失败：${e.code} ${e.message}`);
    }

    // 3) 未知类型被 CHECK 拒绝（23514 = check_violation）
    try {
      await c.query(
        "INSERT INTO notifications (user_id, type, title) VALUES ($1, 'bogus_type', 't')",
        [userId]
      );
      log(false, `INSERT type=bogus_type 竟然成功（约束失效）`);
    } catch (e) {
      log(e.code === "23514", `INSERT type=bogus_type 被拒（${e.code}）`);
    }
  });
} finally {
  if (created) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`\n✓ dropped database ${dbName}`);
  }
}

if (failures > 0) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll constraint assertions PASS");
