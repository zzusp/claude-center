/**
 * 截取「实时对话」重设计后的核心 UI（项目首页 + 项目工作台 + 三点菜单）。
 *
 * 前置：
 *   - DATABASE_URL 指向干净库（推荐：node scripts/ephemeral-db.mjs --keep 起一个）
 *   - 自动起 dev server（CONSOLE_PORT 默认 3030 避开 3000 撞口）
 *
 * 用法：
 *   $env:DATABASE_URL = "<ephemeral url>"; node docs/acceptance/chat-page-redesign/scripts/take-chat-screenshots.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const OUT = path.resolve(__dirname, "..", "round-1");
mkdirSync(OUT, { recursive: true });

const HOST = process.env.CONSOLE_HOST || "127.0.0.1";
const PORT = process.env.CONSOLE_PORT || "3030";
const BASE = `http://${HOST}:${PORT}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

// 清 .next 避免 build/dev 同写假报错
const dotNext = path.join(ROOT, "apps", "console", ".next");
if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(ROOT, "apps", "console");

const child = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", HOST, "--port", PORT], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});

let outBuf = "";
child.stdout.on("data", (d) => (outBuf += d.toString("utf8")));
child.stderr.on("data", (d) => (outBuf += d.toString("utf8")));

async function waitReady() {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server not ready in 120s\n${outBuf}`)), 120_000);
    const it = setInterval(() => {
      if (outBuf.includes("Ready in")) {
        clearTimeout(t);
        clearInterval(it);
        resolve();
      }
    }, 250);
    child.on("exit", (code) => {
      clearTimeout(t);
      clearInterval(it);
      reject(new Error(`server exited ${code}\n${outBuf}`));
    });
  });
}

async function seed() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // 0) 清空一遍演示数据，使脚本可重复运行（仅清示例需要写入的表，user 等保留）。
    await client.query(`DELETE FROM conversations`);
    await client.query(`DELETE FROM worker_project_links`);
    await client.query(`DELETE FROM workers`);
    await client.query(`DELETE FROM projects`);

    // 1) 三个示例项目（一个 git、两个本地）。
    const projects = [
      {
        name: "claude-center",
        vcs: "git",
        repo_url: "git@github.com:zzusp/claude-center.git",
        default_branch: "main",
        description: "AI 编码协作中控台：Console + Worker"
      },
      {
        name: "feature-platform",
        vcs: "git",
        repo_url: "git@github.com:zzusp/feature-platform.git",
        default_branch: "main",
        description: "实验功能开关平台 / 灰度发布"
      },
      {
        name: "infra-runbooks",
        vcs: "none",
        repo_url: null,
        default_branch: "",
        description: "运维 runbook 与本地脚本集合"
      }
    ];
    const projectIds = {};
    for (const p of projects) {
      const r = await client.query(
        `INSERT INTO projects (name, repo_url, default_branch, description, vcs)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [p.name, p.repo_url, p.default_branch, p.description, p.vcs]
      );
      projectIds[p.name] = r.rows[0].id;
    }

    // 2) 一台示例 Worker（在线），并关联到第一个项目，用于演示会话列表。
    const wr = await client.query(
      `INSERT INTO workers (id, name, host_name, app_version, capabilities, metadata,
                            allow_remote_control, max_parallel, terminal_command, claude_pre_command,
                            status, last_seen_at)
       VALUES (gen_random_uuid(), 'dev-desktop', 'WIN-DEV-01', '0.2.14', '{}'::jsonb, '{}'::jsonb,
               true, 2, '', '', 'online', now())
       RETURNING id`
    );
    const workerId = wr.rows[0].id;

    await client.query(
      `INSERT INTO worker_project_links (worker_id, project_id, local_path, enabled, repo_identity)
       VALUES ($1, $2, $3, true, 'main')`,
      [workerId, projectIds["claude-center"], "D:/project/claude-center"]
    );

    // 3) 三条示例会话挂在第一个项目下，演示列表+三点菜单。
    const conversations = [
      { title: "调整新建对话面板字段顺序", branch: "cc/ui-tweaks" },
      { title: "排查 worker 心跳超时", branch: "fix/heartbeat" },
      { title: "梳理 cron schedule 文档", branch: "docs/schedule" }
    ];
    for (const c of conversations) {
      await client.query(
        `INSERT INTO conversations (project_id, worker_id, branch, model, title, auto_reply, auto_decision_hints, created_by, status, updated_at)
         VALUES ($1, $2, $3, 'default', $4, false, '', NULL, 'active', now() - random() * interval '2 hour')`,
        [projectIds["claude-center"], workerId, c.branch, c.title]
      );
    }
    console.log("seeded:", { projectIds, workerId });
  } finally {
    await client.end();
  }
}

async function captureAll() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 登录拿 cookie（admin/admin123 是 008 引导账号）。
  const loginResp = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    headers: { "Content-Type": "application/json" }
  });
  if (loginResp.status() !== 200) {
    console.error("login failed", await loginResp.text());
    throw new Error("login failed");
  }

  const page = await ctx.newPage();

  async function shot(url, name, after = async () => {}) {
    await page.goto(`${BASE}${url}`);
    await page.waitForLoadState("networkidle");
    // 等关键内容容器渲染（项目网格 / 会话列表）；找不到也不阻塞。
    await Promise.race([
      page.waitForSelector(".chat-projects-grid, .chat-wrap", { timeout: 8000 }).catch(() => {}),
      page.waitForTimeout(2000)
    ]);
    await page.waitForTimeout(800);
    await after(page);
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, fullPage: false });
    console.log("✓", path.basename(file));
  }

  // 1) /chat 首页：项目网格
  await shot("/chat", "01-chat-projects.png");

  // 2) /chat/[id]：左侧会话列表 + 右侧空态
  // 取项目 id
  const projResp = await ctx.request.get(`${BASE}/api/projects`);
  const projData = await projResp.json();
  const target = projData.projects.find((p) => p.name === "claude-center");
  if (!target) throw new Error("project claude-center not seeded");
  await shot(`/chat/${target.id}`, "02-chat-project-list.png");

  // 3) 三点菜单展开
  await shot(`/chat/${target.id}`, "03-chat-li-menu.png", async (page) => {
    await page.hover(".chat-li-simple");
    await page.waitForTimeout(200);
    await page.click(".chat-li-simple .chat-li-more");
    await page.waitForTimeout(300);
  });

  // 4) 进入一个对话（消息线为空，但顶部按钮 + 头部 More 菜单仍可看见，验证「结束对话」已移除）
  await shot(`/chat/${target.id}`, "04-chat-thread-empty.png", async (page) => {
    await page.click(".chat-li-simple .chat-li-main-simple");
    await page.waitForTimeout(500);
  });

  // 5) 头部 More 菜单展开，确认无「结束对话」项
  await shot(`/chat/${target.id}`, "05-chat-thread-menu.png", async (page) => {
    await page.click(".chat-li-simple .chat-li-main-simple");
    await page.waitForTimeout(500);
    await page.click(".chat-head-more");
    await page.waitForTimeout(300);
  });

  await browser.close();
}

try {
  await waitReady();
  await seed();
  await captureAll();
  console.log("\n✓ screenshots saved to", OUT);
} catch (e) {
  console.error("[error]", e);
  process.exitCode = 1;
} finally {
  child.kill();
}
