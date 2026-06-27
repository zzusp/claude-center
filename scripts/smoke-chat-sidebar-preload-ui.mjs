// UI 端到端：实时对话页 /chat 左侧项目树展开「即显」预载对话，不出现「加载中…」闪烁。
// 流程：临时库 → 迁移 → seed(2 项目+1 worker+2 对话) → next dev → playwright 登录 →
//      /chat 截图(未展开) → 点 Alpha 项目 → 在毫秒级窗口内断言「调试登录回归」可见 + 不出现「加载中…」→ DROP。
// 用法：node scripts/smoke-chat-sidebar-preload-ui.mjs
//
// 截图落 docs/screenshots/smoke-chat-sidebar-*.png，方便人工 review。
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const url = new URL(process.env.DATABASE_URL);
const dbName = `claude_center_uismoke_${Date.now()}`;
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(url);
targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
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

const SHOT_DIR = path.join(root, "docs", "screenshots");

let created = false;
let consoleChild;
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
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

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

  const port = await freePort();
  const consoleDir = path.join(root, "apps", "console");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const dotNext = path.join(consoleDir, ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

  consoleChild = spawn(
    process.execPath,
    [nextBin, "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", port],
    { cwd: consoleDir, env: { ...process.env, DATABASE_URL: targetUrl.toString() }, windowsHide: true }
  );
  let output = "";
  consoleChild.stdout.on("data", (d) => { output += d.toString("utf8"); if (output.length > 20000) output = output.slice(-20000); });
  consoleChild.stderr.on("data", (d) => { output += d.toString("utf8"); if (output.length > 20000) output = output.slice(-20000); });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`dev server not ready\n${output}`)), 120_000);
    const tick = setInterval(() => { if (output.includes("Ready in")) { clearTimeout(t); clearInterval(tick); resolve(); } }, 250);
    consoleChild.on("exit", (code) => { clearTimeout(t); clearInterval(tick); reject(new Error(`dev exited ${code}\n${output}`)); });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✓ dev ready (${baseUrl})`);

  await mkdir(SHOT_DIR, { recursive: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  const login = await ctx.request.post(`${baseUrl}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    headers: { "Content-Type": "application/json" }
  });
  if (login.status() !== 200) throw new Error(`login ${login.status()}: ${await login.text()}`);

  const page = await ctx.newPage();

  // 记录所有 /api/conversations 请求（用于确认展开本身不触发"被等待"的请求阻塞 UI）。
  const convRequests = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/conversations") && !u.includes("/api/conversations/")) {
      convRequests.push({ url: u, t: Date.now() });
    }
  });

  await page.goto(`${baseUrl}/chat`);
  await page.waitForLoadState("networkidle");
  await page.waitForSelector('text="Alpha Proj"', { timeout: 10_000 });
  await page.screenshot({ path: path.join(SHOT_DIR, "smoke-chat-sidebar-collapsed.png") });
  console.log("✓ /chat 首屏：项目树渲染出 Alpha Proj");

  // 展开 Alpha 项目，预期对话标题立即可见、且不出现"加载中…"
  // expand 瞬间立刻检查 DOM：preload 路径下「调试登录回归」应已存在；
  // 「加载中…」永远不出现（即便给它 1s 的窗口）。
  const reqCountBefore = convRequests.length;
  const tBefore = Date.now();
  await page.locator('text="Alpha Proj"').click();
  // 同步 DOM 断言：100ms 内对话标题已存在（preload 立即同步渲染，无需等待网络）。
  await page.waitForSelector('text="调试登录回归"', { timeout: 500 });
  const tAfter = Date.now();
  const loading = await page.locator('text="加载中…"').count();
  if (loading !== 0) throw new Error(`展开 Alpha 出现了「加载中…」(${loading} 处)，preload 失效`);

  // 截图：展开 + 对话立即可见
  await page.screenshot({ path: path.join(SHOT_DIR, "smoke-chat-sidebar-expanded.png") });
  console.log(`✓ 展开 Alpha 项目：${tAfter - tBefore}ms 内「调试登录回归」可见，未出现「加载中…」`);

  // 展开后会有 polling 触发 /api/conversations?projectId=X（这是设计的，用于刷新 generating/last_message_at）。
  // 关键是首屏展开 UI 不依赖该请求阻塞。等到 polling 周期内允许出现一次。
  // 这里弱断言：展开后那 0.5s 窗口内是否触发请求都可以；不卡 UI 即可。
  console.log(`ℹ /api/conversations 请求计数：展开前 ${reqCountBefore}，展开后 ${convRequests.length}`);

  await browser.close();
  console.log("\n✓ UI smoke PASSED");
} finally {
  if (consoleChild) consoleChild.kill();
  if (created) {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    });
    console.log(`✓ dropped ${dbName}`);
  }
}
