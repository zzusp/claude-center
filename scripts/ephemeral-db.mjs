// 建一次性干净库验证迁移链 / 鉴权，零污染共享 dev 库
// （DATABASE_URL 指向的远程库常停在某兄弟分支状态、缺列会 500）。
// 默认流程：CREATE DATABASE <临时名> → 应用全量迁移 packages/db/migrations/*.sql → DROP DATABASE WITH (FORCE)。
//
// 用法：node scripts/ephemeral-db.mjs [--check] [--keep] [--verify] [--name <db>]
//   --check   只解析 DATABASE_URL + 打印计划，不连库、不建库（零副作用自检）
//   --keep    建库 + 迁移后不删，打印连接串（自己记得 DROP）
//   --verify  迁移后对临时库跑 verify:console（自动取空闲端口）
//   --name    指定库名（默认 claude_center_ephemeral_<时间戳>）
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => args.includes(name);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 加载最近的 .env（不覆盖已有环境变量，与 packages/db/src/env.ts 一致）。
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
if (!baseUrl) {
  throw new Error("DATABASE_URL is required（先配 .env 或设环境变量）");
}

const url = new URL(baseUrl);
const dbName = argVal("--name") ?? `claude_center_ephemeral_${Date.now()}`;
if (!/^[a-z_][a-z0-9_]*$/i.test(dbName)) {
  throw new Error(`非法库名：${dbName}`);
}

const adminUrl = new URL(url);
adminUrl.pathname = "/postgres"; // 维护库：不能在目标库上建 / 删它自己
const targetUrl = new URL(url);
targetUrl.pathname = `/${dbName}`;

const migrationsDir = path.join(root, "packages", "db", "migrations");

console.log(`host:        ${url.host}`);
console.log("admin db:    postgres");
console.log(`temp db:     ${dbName}`);
console.log(`migrations:  ${migrationsDir}`);
console.log(`keep: ${opt("--keep")}   verify: ${opt("--verify")}`);

if (opt("--check")) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  console.log(`\n[--check] 将应用 ${files.length} 个迁移：${files.join(", ")}`);
  console.log("[--check] 未连库、未建库，零副作用。");
  process.exit(0);
}

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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(String(p)));
    });
  });
}

let created = false;
try {
  // 1) 建库（CREATE DATABASE 不能在事务里，单条自动提交）
  await withClient(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
  created = true;
  console.log(`\n✓ created database ${dbName}`);

  // 2) 应用全量迁移（镜像 packages/db/src/scripts/migrate.ts：单事务、记 schema_migrations）
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
      console.log(`  applied ${file}`);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

  // 3) 可选：对临时库跑 verify:console
  if (opt("--verify")) {
    const port = await freePort();
    console.log(`\n>> verify:console（DATABASE_URL→${dbName}, CONSOLE_PORT=${port}）`);
    const code = await new Promise((resolve) => {
      const child = spawn("npm", ["run", "verify:console"], {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
        shell: true,
        env: { ...process.env, DATABASE_URL: targetUrl.toString(), CONSOLE_PORT: port }
      });
      child.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`verify:console 退出码 ${code}`);
    console.log("✓ verify:console 通过");
  }

  if (opt("--keep")) {
    console.log("\n--keep：保留库。连接串：");
    console.log(targetUrl.toString());
    console.log(`用完手动删：DROP DATABASE "${dbName}" WITH (FORCE);`);
  }
} finally {
  if (created && !opt("--keep")) {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
    console.log(`\n✓ dropped database ${dbName}`);
  }
}
