// 一次性临时库串通：CREATE → 跑全量迁移 → 设 DATABASE_URL → 执行指定的 tsx 冒烟 → DROP。
// 用法：node scripts/run-smoke-against-ephemeral.mjs <tsx-path>
// 复用 ephemeral-db.mjs 的建库/迁移/清理流程，省得 smoke 各自维护一份。
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (!target) {
  throw new Error("usage: node scripts/run-smoke-against-ephemeral.mjs <tsx-path>");
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
if (!baseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseUrl);
const dbName = `claude_center_smoke_${Date.now()}`;
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
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log(`✓ migrations applied (${migrationsDir})`);

  console.log(`>> tsx ${target}`);
  const code = await new Promise((resolve) => {
    const child = spawn("npx", ["tsx", target], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      shell: true,
      env: { ...process.env, DATABASE_URL: targetUrl.toString() }
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`smoke exit ${code}`);
} finally {
  if (created) {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
    console.log(`✓ dropped ${dbName}`);
  }
}
