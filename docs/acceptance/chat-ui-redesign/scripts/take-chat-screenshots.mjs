/**
 * 截取「实时对话」UI 重构后的核心视图：
 *   - 项目树侧栏（无项目展开）
 *   - 展开某项目后内嵌的会话历史
 *   - 单条会话选中后的右侧消息线（含端到端 Worker 回复）
 *   - 会话项三点菜单
 *
 * 前置：
 *   - DATABASE_URL 指向干净库（推荐：node scripts/ephemeral-db.mjs --keep 起一个）
 *   - 自动起 dev server（CONSOLE_PORT 默认 3030 避开 3000 撞口）
 *
 * 用法：
 *   $env:DATABASE_URL = "<ephemeral url>"; node docs/acceptance/chat-ui-redesign/scripts/take-chat-screenshots.mjs
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
    // 0) 清空一遍演示数据，使脚本可重复运行。
    await client.query(`DELETE FROM conversations`);
    await client.query(`DELETE FROM worker_project_links`);
    await client.query(`DELETE FROM workers`);
    await client.query(`DELETE FROM projects`);

    // 1) 多个示例项目（mock 参考图氛围：UUID 前缀名、有意义名、不同 VCS）。
    const projects = [
      {
        name: "2ef704f2-3aff-4c0d-a8e9",
        vcs: "none",
        repo_url: null,
        default_branch: "",
        description: "未命名工作区（UUID 前缀名）"
      },
      { name: "project", vcs: "none", repo_url: null, default_branch: "", description: "草稿项目" },
      { name: "card-story", vcs: "none", repo_url: null, default_branch: "", description: "卡牌叙事原型" },
      {
        name: "claude-code-session",
        vcs: "git",
        repo_url: "git@github.com:zzusp/claude-code-session.git",
        default_branch: "main",
        description: "Claude Code 会话能力沉淀"
      },
      {
        name: "vision-health",
        vcs: "git",
        repo_url: "git@github.com:zzusp/vision-health.git",
        default_branch: "main",
        description: "视力健康追踪"
      },
      {
        name: "claude-center",
        vcs: "git",
        repo_url: "git@github.com:zzusp/claude-center.git",
        default_branch: "main",
        description: "AI 编码协作中控台：Console + Worker"
      },
      {
        name: "claude-hive",
        vcs: "git",
        repo_url: "git@github.com:zzusp/claude-hive.git",
        default_branch: "main",
        description: "多 Worker 调度蜂巢"
      },
      {
        name: "claude-cloud",
        vcs: "git",
        repo_url: "git@github.com:zzusp/claude-cloud.git",
        default_branch: "main",
        description: "云端 Claude Worker"
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

    // 2) 一台示例 Worker（在线），关联到 claude-code-session 项目用于展示会话历史。
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
      [workerId, projectIds["claude-code-session"], "D:/project/claude-code-session"]
    );

    // 3) 在 claude-code-session 下塞 5 条会话，参考图同款标题，让「展开显示」无须出现也能撑满列表。
    const conversations = [
      "<command-name>/model</command-name>",
      "调整\"修改的文件\"侧边弹窗中的…",
      "修改的文件弹窗中，对话应该默…",
      "会话历史中的claude处理中多渲…",
      "修改的文件弹窗中的文件变更，…"
    ];
    const convIds = [];
    for (const title of conversations) {
      const r = await client.query(
        `INSERT INTO conversations (project_id, worker_id, branch, model, title, auto_reply, auto_decision_hints, created_by, status, updated_at)
         VALUES ($1, $2, 'main', 'default', $3, false, '', NULL, 'active', now() - interval '14 days')
         RETURNING id`,
        [projectIds["claude-code-session"], workerId, title]
      );
      convIds.push(r.rows[0].id);
    }
    console.log("seeded:", { workerId, convIds: convIds.length, projects: projects.length });
    return { projectIds, workerId, convIds };
  } finally {
    await client.end();
  }
}

// 端到端联调 Worker 应答流（不依赖真实 Worker 进程）：用 DB helpers 推一轮回答 + 注入 jsonl。
async function driveWorkerReply({ conversationId, workerId, userBody, assistantBody }) {
  const dbModule = await import(`file:///${path.resolve(ROOT, "packages/db/dist/index.js").replace(/\\/g, "/")}`);
  const {
    addConversationMessage,
    claimNextConversationTurn,
    finalizeConversationTurn,
    upsertConversationSession,
    closePool
  } = dbModule;
  try {
    await addConversationMessage(dbModule.getPool(), {
      conversationId,
      role: "user",
      body: userBody
    });
    const turn = await claimNextConversationTurn(dbModule.getPool(), workerId);
    if (!turn) throw new Error("no turn claimed");
    const sessionId = "demo-session-" + conversationId.slice(0, 8);
    const jsonl =
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: [{ type: "text", text: userBody }] }
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: assistantBody }]
        }
      });
    await upsertConversationSession(dbModule.getPool(), conversationId, jsonl);
    await finalizeConversationTurn(dbModule.getPool(), {
      conversationId,
      messageId: turn.id,
      body: assistantBody,
      sessionId
    });
  } finally {
    await closePool();
  }
}

async function captureAll() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

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
    // 实时对话页 3s 轮询永不空闲，networkidle 会必然超时；改用 domcontentloaded + 显式 selector 等待。
    await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    await Promise.race([
      page.waitForSelector(".chat-wrap", { timeout: 10000 }).catch(() => {}),
      page.waitForTimeout(3000)
    ]);
    await page.waitForTimeout(1200);
    await after(page);
    const file = path.join(OUT, name);
    await page.screenshot({ path: file, fullPage: false });
    console.log("✓", path.basename(file));
  }

  // 1) /chat 首页：项目树侧栏（无项目展开）+ 右侧空态。
  await shot("/chat", "01-chat-sidebar.png");

  // 2) 进入 claude-code-session 后侧栏展开，内嵌会话历史。
  const projResp = await ctx.request.get(`${BASE}/api/projects`);
  const projData = await projResp.json();
  const target = projData.projects.find((p) => p.name === "claude-code-session");
  if (!target) throw new Error("project claude-code-session not seeded");
  await shot(`/chat/${target.id}`, "02-chat-sidebar-expanded.png");

  // 3) 三点菜单（会话级）展开：重命名 / 对话设置 / 删除对话。
  await shot(`/chat/${target.id}`, "03-chat-conv-menu.png", async (page) => {
    await page.hover(".chat-side-conv:first-of-type");
    await page.waitForTimeout(200);
    await page.click(".chat-side-conv:first-of-type .chat-side-conv-menu .chat-side-act");
    await page.waitForTimeout(300);
  });

  // 4) 选中第一条会话：右侧出现消息线（包含 driveWorkerReply 推的一轮 user → assistant 应答）。
  await shot(`/chat/${target.id}`, "04-chat-thread-replied.png", async (page) => {
    await page.click(".chat-side-conv:first-of-type .chat-side-conv-main");
    await page.waitForSelector(".chat-msgs .tx-row.asst", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  });

  await browser.close();
}

try {
  await waitReady();
  const seedInfo = await seed();
  // 在第一条会话上跑一轮 user → worker → assistant 应答，验证消息渲染通路。
  await driveWorkerReply({
    conversationId: seedInfo.convIds[0],
    workerId: seedInfo.workerId,
    userBody: "看一下 chat 页改完后的侧栏 + 项目展开效果是不是符合参考图",
    assistantBody:
      "侧栏已按参考图重构：项目树点击展开后内嵌会话历史，标题加粗 + 文件夹图标按 git/none 区分；hover 时显示 ⋯ / 新建对话按钮，会话项含 ⋯ 三点菜单。\n\n截图 04 是真实的一轮 user → assistant 应答渲染。"
  });
  await captureAll();
  console.log("\n✓ screenshots saved to", OUT);
} catch (e) {
  console.error("[error]", e);
  process.exitCode = 1;
} finally {
  child.kill();
}
