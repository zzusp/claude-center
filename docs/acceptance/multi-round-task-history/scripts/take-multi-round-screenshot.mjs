/**
 * 验证 ResultPanel 多轮渲染：建临时库 → 跑迁移 → 种三轮成功任务 → 起 console dev → playwright 截图 → cleanup。
 *
 * docs/spec/multi-round-task-history.md
 *
 * 用法：node docs/acceptance/multi-round-task-history/scripts/take-multi-round-screenshot.mjs
 * 前置：DATABASE_URL 指向有 CREATEDB 权限的 PG（与 ephemeral-db.mjs 同源）。
 *
 * 输出：docs/acceptance/multi-round-task-history/round-1/{task-detail-multi-round.png, task-detail-multi-round-zoomed.png}
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const OUT = path.resolve(__dirname, "..", "round-1");
mkdirSync(OUT, { recursive: true });

// 加载 .env（DATABASE_URL / 管理员凭据）
{
  const envFile = path.join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (set in .env or pass via env)");

const HOST = process.env.CONSOLE_HOST || "127.0.0.1";
const PORT = process.env.CONSOLE_PORT || "3033";
const BASE = `http://${HOST}:${PORT}`;

const pg = (await import("pg")).default;

// 1) 建临时库 + 跑全量迁移
const baseUrl = new URL(process.env.DATABASE_URL);
const dbName = `claude_center_mr_${Date.now()}`;
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const tgtUrl = new URL(baseUrl);
tgtUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(ROOT, "packages", "db", "migrations");

async function withClient(connUrl, fn) {
  const c = new pg.Client({ connectionString: connUrl.toString() });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

let createdDb = false;
let nextChild = null;

try {
  await withClient(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE "${dbName}"`);
  });
  createdDb = true;
  console.log(`✓ created ${dbName}`);

  await withClient(tgtUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const sql = readFileSync(path.join(migrationsDir, f), "utf8");
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]);
    }
    await c.query("COMMIT");
  });
  console.log(`✓ migrations applied (${migrationsDir})`);

  // 2) bootstrap admin（008_auth_rbac.sql 引导的 admin/admin123，下方 dev server 用同凭据登录）
  //    + 种一个三轮成功任务（用 @claude-center/db 的 markTaskSuccess 走真实累计路径）
  process.env.DATABASE_URL = tgtUrl.toString();
  const { default: pgMod } = await import("pg");
  const c = new pgMod.Client({ connectionString: tgtUrl.toString() });
  await c.connect();
  try {
    // admin 用户：008_auth_rbac.sql 迁移已 bootstrap admin/admin123（pgcrypto crypt + gen_salt），无需再插。
    const projectId = "00000000-0000-0000-0000-0000000000ff";
    await c.query(
      `INSERT INTO projects (id, name, repo_url, default_branch, description)
       VALUES ($1, '多轮验证项目', 'https://example.invalid/multi-round.git', 'main', '多轮累计 UI 验证')`,
      [projectId]
    );
    // 主仓 project_repos 行：syncMainProjectRepo 在下面 import 后调（已经经过 027 删 relative_path 后的列集合）
    const workerId = "00000000-0000-0000-0000-0000000000fd";
    await c.query(
      `INSERT INTO workers (id, name, host_name, app_version)
       VALUES ($1, 'multi-round-worker', 'demo', '0.0.0-demo')`,
      [workerId]
    );
    // worker_project_links：local_path + repo_identity 都 NOT NULL；纯演示用占位
    await c.query(
      `INSERT INTO worker_project_links (worker_id, project_id, enabled, local_path, repo_identity)
       VALUES ($1, $2, true, 'D:\\\\demo\\\\multi-round', 'demo-identity') ON CONFLICT DO NOTHING`,
      [workerId, projectId]
    );
  } finally { await c.end(); }
  console.log("✓ bootstrap admin + project + worker");

  // 通过 @claude-center/db 跑真实 markTaskSuccess 累计三轮（与 worker 路径一致）
  const dbPkg = await import(pathToFileURL(path.join(ROOT, "packages", "db", "dist", "index.js")).href);
  const { getPool, createTask, syncMainProjectRepo, continueTask, markTaskSuccess, closePool } = dbPkg;
  const pool = getPool();
  // 主仓 project_repos：用现成 helper，自动适配迁移后列集合
  await syncMainProjectRepo(pool, "00000000-0000-0000-0000-0000000000ff");
  const taskId = (await createTask(pool, {
    projectId: "00000000-0000-0000-0000-0000000000ff",
    title: "多轮累计 UI 演示任务",
    description: "本任务用于验证 ResultPanel 多轮折叠 + PR URL 链接。",
    baseBranch: "main",
    workBranch: "feature/multi-round-demo",
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  })).id;
  console.log(`✓ task created: ${taskId}`);
  // claim
  const workerId = "00000000-0000-0000-0000-0000000000fd";
  await pool.query(
    `UPDATE tasks SET status='running', claimed_by=$2, claimed_at=now(), started_at=now() WHERE id=$1`,
    [taskId, workerId]
  );
  // 三轮
  const rounds = [
    {
      output: "## 首轮总结\n\n- 给登录按钮加了 onClick 事件绑定\n- 单测覆盖了快速点击多次的去抖场景\n- 没动样式",
      prUrls: ["https://github.com/example/repo/pull/100"]
    },
    {
      output: "## 第 1 轮续跑总结\n\n- 加上了点击失败时的红色错误 toast（沿用现有 ToastProvider）\n- 单测补了 toast 出现/消失的断言",
      prUrls: ["https://github.com/example/repo/pull/101"]
    },
    {
      output: "## 第 2 轮续跑总结\n\n- 多仓改动：主仓加了 i18n key、子仓补了对应中英文翻译\n- 视觉上做了暗色模式的对比度调整",
      prUrls: ["https://github.com/example/repo/pull/102", "https://github.com/example/sub-repo/pull/103"]
    }
  ];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    await markTaskSuccess(pool, taskId, workerId,
      { workdir: "/wt", submitMode: "pr", claudeResult: r.output, multiRepo: [] },
      r.prUrls[0],
      { output: r.output, prUrls: r.prUrls, submitMode: "pr" }
    );
    if (i < rounds.length - 1) {
      // 模拟续跑：API 端会调 continueTask，这里直接调
      await continueTask(pool, taskId, `第 ${i + 1} 轮反馈：还差点什么，再来一轮`);
      await pool.query(
        `UPDATE tasks SET status='running', continuation_requested_at=NULL WHERE id=$1`,
        [taskId]
      );
    }
  }
  console.log("✓ seeded 3-round success task");
  await closePool();

  // 3) 起 console dev server
  const dotNext = path.join(ROOT, "apps", "console", ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const consoleDir = path.join(ROOT, "apps", "console");
  nextChild = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", HOST, "--port", PORT], {
    cwd: consoleDir,
    env: { ...process.env, DATABASE_URL: tgtUrl.toString() },
    windowsHide: true
  });
  let buf = "";
  nextChild.stdout.on("data", (d) => (buf += d.toString("utf8")));
  nextChild.stderr.on("data", (d) => (buf += d.toString("utf8")));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`console not ready in 120s:\n${buf}`)), 120_000);
    const it = setInterval(() => {
      if (buf.includes("Ready in")) { clearTimeout(t); clearInterval(it); resolve(); }
    }, 250);
    nextChild.on("exit", (code) => { clearTimeout(t); clearInterval(it); reject(new Error(`exit ${code}\n${buf}`)); });
  });
  console.log(`✓ console ready at ${BASE}`);

  // 4) playwright 登录 + 访问 task detail + 截图
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  // 引导管理员登录（与 verify-console 一致）
  const loginResp = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    headers: { "Content-Type": "application/json" }
  });
  if (loginResp.status() !== 200) throw new Error(`login failed: ${loginResp.status()} ${await loginResp.text()}`);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/tasks/${taskId}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
  // 概览 tab（默认即是）
  const fullShot = path.join(OUT, "task-detail-multi-round.png");
  await page.screenshot({ path: fullShot, fullPage: true });
  console.log(`✓ ${fullShot}`);

  // 展开所有历史轮（点击第二、第三个 details 标头）→ 再截一张
  const details = await page.locator(".ov-result-round").all();
  for (const d of details) {
    const open = await d.getAttribute("open");
    if (open === null) {
      await d.locator(".ov-result-round-head").first().click();
      await page.waitForTimeout(200);
    }
  }
  await page.waitForTimeout(500);
  const allOpenShot = path.join(OUT, "task-detail-multi-round-all-open.png");
  await page.screenshot({ path: allOpenShot, fullPage: true });
  console.log(`✓ ${allOpenShot}`);
  await browser.close();
} finally {
  if (nextChild && !nextChild.killed) {
    nextChild.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (createdDb) {
    try {
      await withClient(adminUrl, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      });
      console.log(`✓ dropped ${dbName}`);
    } catch (e) {
      console.warn(`drop ${dbName} failed: ${e.message ?? e}`);
    }
  }
}
