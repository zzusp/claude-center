// 验证 021 迁移 + createTask/updateTask 的 auto_reply / auto_decision_hints 字段端到端 round-trip。
// 用法：node scripts/ephemeral-db.mjs --verify 之外，单独跑 round-trip 校验：
//   npx tsx docs/acceptance/task-auto-reply/scripts/verify-auto-reply.mts
// 需 .env 里有 DATABASE_URL 指向能建临时库的实例（与 ephemeral-db.mjs 同一台）。
import { randomUUID } from "node:crypto";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// 与 scripts/ephemeral-db.mjs 同款：用 Node 内建 loadEnvFile（不覆盖已有 env）。
const envPath = path.join(repoRoot, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL not set; run after sourcing .env");
const url = new URL(rawUrl);
const adminDbUrl = new URL(rawUrl);
adminDbUrl.pathname = "/postgres";
const tempDbName = `claude_center_verify_auto_reply_${Date.now()}`;

function withDb(name: string) {
  const u = new URL(rawUrl);
  u.pathname = `/${name}`;
  return u.toString();
}

const log = (...args: unknown[]) => console.log("[verify]", ...args);

async function main() {
  log("admin url:", adminDbUrl.toString().replace(/:[^:@/]+@/, ":***@"));
  log("temp db:  ", tempDbName);
  const admin = new pg.Client({ connectionString: adminDbUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${tempDbName}"`);
  } finally {
    await admin.end();
  }

  const client = new pg.Client({ connectionString: withDb(tempDbName) });
  await client.connect();
  try {
    const migrationsDir = path.join(repoRoot, "packages/db/migrations");
    const entries = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    await client.query("BEGIN");
    for (const file of entries) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
    }
    await client.query("COMMIT");
    log(`applied ${entries.length} migrations (last: ${entries.at(-1)})`);

    // 1) project
    const projectId = randomUUID();
    await client.query(
      `INSERT INTO projects (id, name, repo_url) VALUES ($1, $2, $3)`,
      [projectId, `verify-${tempDbName}`, `https://example.invalid/${tempDbName}`]
    );

    // 2) 直接走与 createTask 完全一致的 SQL（13 个占位符），验证占位符数 / 顺序 / 默认值。
    const insertRes = await client.query(
      `INSERT INTO tasks (project_id, title, description, base_branch, work_branch, target_branch, submit_mode, model, auto_merge_pr, auto_reply, auto_decision_hints, status, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, auto_reply, auto_decision_hints, auto_merge_pr, status`,
      [projectId, "smoke title", "smoke desc", "main", "cc/smoke", "main", "pr", "default", false, true, "prefer minimal change; skip tests", "draft", null]
    );
    const created = insertRes.rows[0] as { id: string; auto_reply: boolean; auto_decision_hints: string; auto_merge_pr: boolean; status: string };
    if (!created.auto_reply || created.auto_decision_hints !== "prefer minimal change; skip tests") {
      throw new Error(`createTask round-trip mismatch: ${JSON.stringify(created)}`);
    }
    log("createTask:", created);

    // 3) updateTask SQL（13 个占位符）round-trip
    const updateRes = await client.query(
      `UPDATE tasks
          SET title = $2, description = $3, base_branch = $4, work_branch = $5, target_branch = $6,
              submit_mode = $7, auto_merge_pr = $8, auto_reply = $9, auto_decision_hints = $10,
              model = $11, scheduled_at = $12, status = $13, updated_at = now()
        WHERE id = $1 AND status IN ('draft', 'scheduled')
        RETURNING id, auto_reply, auto_decision_hints, model, status`,
      [created.id, "smoke title 2", "smoke desc 2", "main", "cc/smoke", "main", "pr", true, false, "", "opus", null, "draft"]
    );
    const updated = updateRes.rows[0] as { id: string; auto_reply: boolean; auto_decision_hints: string; model: string };
    if (updated.auto_reply || updated.auto_decision_hints !== "" || updated.model !== "opus") {
      throw new Error(`updateTask round-trip mismatch: ${JSON.stringify(updated)}`);
    }
    log("updateTask:", updated);

    // 4) 现有任务默认值（DEFAULT false / '' 不破坏存量任务）
    const defaultsRes = await client.query(
      `INSERT INTO tasks (project_id, title, description, base_branch, work_branch, target_branch, submit_mode, model)
       VALUES ($1, 'noflag', 'noflag', 'main', 'cc/noflag', 'main', 'pr', 'default')
       RETURNING auto_reply, auto_decision_hints`,
      [projectId]
    );
    const defaults = defaultsRes.rows[0] as { auto_reply: boolean; auto_decision_hints: string };
    if (defaults.auto_reply !== false || defaults.auto_decision_hints !== "") {
      throw new Error(`existing-row defaults mismatch: ${JSON.stringify(defaults)}`);
    }
    log("defaults (legacy insert):", defaults);

    log("PASS round-trip + defaults");
  } finally {
    await client.end();
    const dropper = new pg.Client({ connectionString: adminDbUrl.toString() });
    await dropper.connect();
    try {
      await dropper.query(`DROP DATABASE IF EXISTS "${tempDbName}" WITH (FORCE)`);
      log(`dropped ${tempDbName}`);
    } finally {
      await dropper.end();
    }
  }
}

main().catch((err) => {
  console.error("[verify] FAIL", err);
  process.exitCode = 1;
});
