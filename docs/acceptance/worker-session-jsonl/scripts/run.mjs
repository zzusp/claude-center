// 编排：建一次性临时库(含全量迁移) → 跑 verify.mts(DATABASE_URL→临时库, CLAUDE_CONFIG_DIR→临时目录) → 删库。
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");

// 加载 .env DATABASE_URL
let dir = root;
for (let i = 0; i < 8; i += 1) {
  const c = path.join(dir, ".env");
  if (existsSync(c)) {
    process.loadEnvFile(c);
    break;
  }
  const p = path.dirname(dir);
  if (p === dir) break;
  dir = p;
}
const base = process.env.DATABASE_URL;
if (!base) throw new Error("DATABASE_URL required");

const dbName = `cc_verify_sess_${Date.now()}`;
const target = base.replace(/\/[^/]+(\?.*)?$/, `/${dbName}$1`);
const cfgDir = path.join(os.tmpdir(), `cc-verify-cfg-${dbName}`);

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit", windowsHide: true, shell: true, env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const pg = (await import("pg")).default;
async function dropDb() {
  const adminUrl = base.replace(/\/[^/]+(\?.*)?$/, `/postgres$1`);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    console.log(`\n✓ dropped ${dbName}`);
  } finally {
    await client.end();
  }
}

let code = 1;
try {
  const mig = await run("node", ["scripts/ephemeral-db.mjs", "--keep", "--name", dbName]);
  if (mig !== 0) throw new Error(`ephemeral-db 失败 (${mig})`);
  code = await run("npx", ["tsx", "docs/acceptance/worker-session-jsonl/scripts/verify.mts"], {
    DATABASE_URL: target,
    CLAUDE_CONFIG_DIR: cfgDir
  });
} finally {
  try {
    rmSync(cfgDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await dropDb().catch((e) => console.error("drop failed:", e.message));
}
process.exit(code);
