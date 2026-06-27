// 端到端冒烟：/api/projects?include=conversations 返回每个项目下的对话清单；不带 include 时保持向后兼容（无 conversations 字段）。
// 流程：建临时库 → 迁移 → seed(项目×2 + worker + conv×2) → 起 next dev → login → 两次 GET /api/projects 断言形状 → DROP DB。
// 用法：node scripts/smoke-projects-include-conversations.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required（先配 .env）");
}

const baseConnStr = process.env.DATABASE_URL;
const url = new URL(baseConnStr);
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
let consoleChild;
try {
  // 1) 临时库 + 迁移
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
  console.log("✓ migrations applied");

  // 2) seed：两项目 + 一 worker + 每项目一会话；conv1 上挂一条用户消息，让 listConversations 派生的 last_message_at 非空。
  const ids = {
    projectAlpha: "00000000-0000-0000-0000-00000000a001",
    projectBeta: "00000000-0000-0000-0000-00000000a002",
    worker: "00000000-0000-0000-0000-00000000b001"
  };
  await withClient(targetUrl, async (c) => {
    await c.query(
      `INSERT INTO projects (id, name, repo_url, default_branch) VALUES
        ($1, 'Alpha Proj', 'https://x/alpha.git', 'main'),
        ($2, 'Beta Proj',  'https://x/beta.git',  'main')`,
      [ids.projectAlpha, ids.projectBeta]
    );
    await c.query(
      `INSERT INTO workers (id, name, status, host_name, app_version, capabilities, metadata, last_seen_at)
       VALUES ($1, 'worker-x', 'online', 'host-x', 'test', '{}'::jsonb, '{}'::jsonb, now())`,
      [ids.worker]
    );
    await c.query(
      `INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity, enabled) VALUES
        ($1, $2, '/tmp/a', 'a.git', true),
        ($1, $3, '/tmp/b', 'b.git', true)`,
      [ids.worker, ids.projectAlpha, ids.projectBeta]
    );
    const conv1 = await c.query(
      `INSERT INTO conversations (project_id, worker_id, branch, model, title)
       VALUES ($1, $2, 'main', 'default', '调试登录回归') RETURNING id`,
      [ids.projectAlpha, ids.worker]
    );
    await c.query(
      `INSERT INTO conversations (project_id, worker_id, branch, model, title)
       VALUES ($1, $2, 'main', 'default', '整理 API 文档')`,
      [ids.projectBeta, ids.worker]
    );
    await c.query(
      `INSERT INTO conversation_messages (conversation_id, seq, role, body, status)
       VALUES ($1, 1, 'user', '复现登录失败链路', 'done')`,
      [conv1.rows[0].id]
    );
  });
  console.log("✓ seed done");

  // 3) 起 next dev 指向临时库
  const port = await freePort();
  const consoleDir = path.join(root, "apps", "console");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const dotNext = path.join(consoleDir, ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

  consoleChild = spawn(
    process.execPath,
    [nextBin, "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", port],
    {
      cwd: consoleDir,
      env: { ...process.env, DATABASE_URL: targetUrl.toString() },
      windowsHide: true
    }
  );
  let output = "";
  consoleChild.stdout.on("data", (d) => {
    output += d.toString("utf8");
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  consoleChild.stderr.on("data", (d) => {
    output += d.toString("utf8");
    if (output.length > 20_000) output = output.slice(-20_000);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev server not ready\n${output}`)), 120_000);
    const tick = setInterval(() => {
      if (output.includes("Ready in")) {
        clearTimeout(timer);
        clearInterval(tick);
        resolve();
      }
    }, 250);
    consoleChild.on("exit", (code) => {
      clearTimeout(timer);
      clearInterval(tick);
      reject(new Error(`dev server exited ${code}\n${output}`));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✓ dev server ready (${baseUrl})`);

  // 4) login（引导管理员）
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (!login.ok) throw new Error(`login failed ${login.status}: ${await login.text()}`);
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  if (!token) throw new Error("no cc_session cookie");
  const cookie = `cc_session=${token}`;
  console.log("✓ login ok");

  // 5) 不带 include：返回不带 conversations 字段（向后兼容）
  const r1 = await fetch(`${baseUrl}/api/projects`, { headers: { cookie } });
  if (!r1.ok) throw new Error(`GET /api/projects ${r1.status}`);
  const d1 = await r1.json();
  if (!Array.isArray(d1.projects) || d1.projects.length !== 2) {
    throw new Error(`projects 数量异常: ${JSON.stringify(d1.projects?.length)}`);
  }
  for (const p of d1.projects) {
    if ("conversations" in p) {
      throw new Error(`未请求 include=conversations 但项目仍带 conversations 字段：${p.id}`);
    }
    if (!Array.isArray(p.subRepos)) {
      throw new Error(`subRepos 字段丢失：${p.id}`);
    }
  }
  console.log("✓ /api/projects（无 include）形状回归正确");

  // 6) 带 include=conversations：每项目附带 conversations，分组正确
  const r2 = await fetch(`${baseUrl}/api/projects?include=conversations`, { headers: { cookie } });
  if (!r2.ok) throw new Error(`GET /api/projects?include=conversations ${r2.status}`);
  const d2 = await r2.json();
  if (!Array.isArray(d2.projects) || d2.projects.length !== 2) {
    throw new Error(`projects 数量异常: ${d2.projects?.length}`);
  }
  const byId = new Map(d2.projects.map((p) => [p.id, p]));
  const alpha = byId.get(ids.projectAlpha);
  const beta = byId.get(ids.projectBeta);
  if (!alpha || !beta) throw new Error("找不到 seed 出来的项目");
  if (!Array.isArray(alpha.conversations) || alpha.conversations.length !== 1) {
    throw new Error(`alpha 项目 conversations 数量异常: ${JSON.stringify(alpha.conversations?.length)}`);
  }
  if (alpha.conversations[0].title !== "调试登录回归") {
    throw new Error(`alpha 对话 title 不对: ${alpha.conversations[0].title}`);
  }
  if (alpha.conversations[0].project_id !== ids.projectAlpha) {
    throw new Error(`alpha 对话 project_id 没对上`);
  }
  if (!alpha.conversations[0].last_message_at) {
    throw new Error("alpha 对话 last_message_at 应该非空（已 seed 一条用户消息）");
  }
  if (!Array.isArray(beta.conversations) || beta.conversations.length !== 1) {
    throw new Error(`beta 项目 conversations 数量异常: ${JSON.stringify(beta.conversations?.length)}`);
  }
  if (beta.conversations[0].title !== "整理 API 文档") {
    throw new Error(`beta 对话 title 不对: ${beta.conversations[0].title}`);
  }
  // subRepos 仍要保留
  if (!Array.isArray(alpha.subRepos) || !Array.isArray(beta.subRepos)) {
    throw new Error("subRepos 在 include=conversations 时丢失");
  }
  console.log("✓ /api/projects?include=conversations 项目+对话分组正确");

  console.log("\n✓ ALL CHECKS PASSED");
} finally {
  if (consoleChild) {
    consoleChild.kill();
  }
  if (created) {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
    console.log(`✓ dropped ${dbName}`);
  }
}
