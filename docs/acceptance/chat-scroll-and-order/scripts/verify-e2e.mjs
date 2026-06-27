// e2e：
//   1) 在 conversation 里跑「成功→失败→成功」三轮，确认 chat-msgs 里 .tx-row 顺序为：
//      user1 / asst1 / user2 / FAILED / user3 / asst3（失败条夹在「失败那轮」与「下一轮 user」之间）。
//   2) 把 chat-msgs 滚到顶端后，等 4 秒（>3 秒轮询周期），确认 scrollTop 没被自动拽到底部。
//
// 用法：
//   $env:DATABASE_URL = "<ephemeral url>"; node docs/acceptance/chat-scroll-and-order/scripts/verify-e2e.mjs
//   或直接：node scripts/ephemeral-db.mjs --keep   # 拿临时库，然后跑本脚本
//
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const HOST = process.env.CONSOLE_HOST || "127.0.0.1";
const PORT = process.env.CONSOLE_PORT || "3033";
const BASE = `http://${HOST}:${PORT}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

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

function waitReady() {
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

async function seedAndDrive() {
  const dbModule = await import(`file:///${path.resolve(ROOT, "packages/db/dist/index.js").replace(/\\/g, "/")}`);
  const pool = dbModule.getPool();

  // 清并建演示项目 + worker + conversation
  await pool.query(`DELETE FROM conversation_messages`);
  await pool.query(`DELETE FROM conversation_sessions`);
  await pool.query(`DELETE FROM conversations`);
  await pool.query(`DELETE FROM worker_project_links`);
  await pool.query(`DELETE FROM workers`);
  await pool.query(`DELETE FROM projects`);

  const projRes = await pool.query(
    `INSERT INTO projects (name, repo_url, default_branch, description, vcs)
     VALUES ('claude-center', 'git@github.com:zzusp/claude-center.git', 'main', 'demo', 'git') RETURNING id`
  );
  const projectId = projRes.rows[0].id;

  const wkRes = await pool.query(
    `INSERT INTO workers (id, name, host_name, app_version, capabilities, metadata,
                          allow_remote_control, max_parallel, terminal_command, claude_pre_command,
                          status, last_seen_at)
     VALUES (gen_random_uuid(), 'dev-desktop', 'WIN', '0.2.15', '{}'::jsonb, '{}'::jsonb,
             true, 2, '', '', 'online', now())
     RETURNING id`
  );
  const workerId = wkRes.rows[0].id;

  await pool.query(
    `INSERT INTO worker_project_links (worker_id, project_id, local_path, enabled, repo_identity)
     VALUES ($1, $2, 'D:/demo', true, 'main')`,
    [workerId, projectId]
  );

  const convRes = await pool.query(
    `INSERT INTO conversations (project_id, worker_id, branch, model, title, auto_reply, auto_decision_hints, created_by, status, updated_at)
     VALUES ($1, $2, 'main', 'default', 'claude-center 发版', false, '', NULL, 'active', now() - interval '1 hour')
     RETURNING id`,
    [projectId, workerId]
  );
  const conversationId = convRes.rows[0].id;

  const { addConversationMessage, claimNextConversationTurn, finalizeConversationTurn, failConversationTurn, upsertConversationSession } = dbModule;

  // 拼 jsonl 同形片段（user→assistant 各一段）；timestamp 按事件实际时间，保证 chat-thread 的 mergeEntries 能按时间插失败条。
  const session = `demo-session-${conversationId.slice(0, 8)}`;
  const lines = [];
  function pushLine(type, text, ts) {
    lines.push(
      JSON.stringify({
        type,
        sessionId: session,
        timestamp: ts,
        message: { role: type, content: [{ type: "text", text }] }
      })
    );
  }

  // === 第 1 轮：成功 ===
  await addConversationMessage(pool, { conversationId, role: "user", body: "msg-1" });
  let turn = await claimNextConversationTurn(pool, workerId);
  if (!turn) throw new Error("no turn 1");
  pushLine("user", "msg-1", "2026-06-28T10:00:00Z");
  pushLine("assistant", "reply-1", "2026-06-28T10:00:01Z");
  await upsertConversationSession(pool, conversationId, lines.join("\n"));
  await finalizeConversationTurn(pool, { conversationId, messageId: turn.id, body: "reply-1", sessionId: session });

  // === 第 2 轮：失败 ===（jsonl 只到 user-2，failure ts = 10:01:30）
  await addConversationMessage(pool, { conversationId, role: "user", body: "msg-2 这条会失败" });
  turn = await claimNextConversationTurn(pool, workerId);
  if (!turn) throw new Error("no turn 2");
  pushLine("user", "msg-2 这条会失败", "2026-06-28T10:01:00Z");
  await upsertConversationSession(pool, conversationId, lines.join("\n"));
  await failConversationTurn(pool, { messageId: turn.id, errorMessage: "claude exit 1 (network)" });
  // 调整 failed 消息的 created_at 到 10:01:30，确保严格夹在 msg-2(10:01:00) 与 msg-3(10:02:00) 之间。
  await pool.query(`UPDATE conversation_messages SET created_at = '2026-06-28T10:01:30Z' WHERE id = $1`, [turn.id]);

  // === 第 3 轮：成功 ===
  await addConversationMessage(pool, { conversationId, role: "user", body: "msg-3 重试" });
  turn = await claimNextConversationTurn(pool, workerId);
  if (!turn) throw new Error("no turn 3");
  pushLine("user", "msg-3 重试", "2026-06-28T10:02:00Z");
  pushLine("assistant", "reply-3 OK", "2026-06-28T10:02:01Z");
  await upsertConversationSession(pool, conversationId, lines.join("\n"));
  await finalizeConversationTurn(pool, { conversationId, messageId: turn.id, body: "reply-3 OK", sessionId: session });

  await dbModule.closePool();

  return { projectId, conversationId };
}

async function captureAndAssert({ projectId, conversationId }) {
  const browser = await chromium.launch({ headless: true });
  // 小视口 + 多轮长内容确保 chat-msgs 一定 overflow，否则 scrollTop=0 测不到「轮询不拽底」。
  const ctx = await browser.newContext({ viewport: { width: 900, height: 400 } });
  const loginResp = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: "admin", password: "admin123" },
    headers: { "Content-Type": "application/json" }
  });
  if (loginResp.status() !== 200) throw new Error(`login failed: ${await loginResp.text()}`);

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.warn("[page error]", e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.warn(`[page ${msg.type()}]`, msg.text());
    }
  });

  const url = `${BASE}/chat/${projectId}?c=${conversationId}`;
  console.log("goto:", url);
  const resp = await page.goto(url);
  console.log("response status:", resp?.status());
  console.log("page url after goto:", page.url());
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  // 调试：先看 chat-msgs 是否存在
  const msgsCount = await page.$$eval(".chat-msgs", (els) => els.length);
  const txRowCount = await page.$$eval(".chat-msgs .tx-row", (els) => els.length);
  console.log("chat-msgs count:", msgsCount, "tx-row count:", txRowCount);
  // 等 chat-msgs 渲染（这里至少 2 个 .tx-row）
  await page.waitForSelector(".chat-msgs .tx-row", { timeout: 15000 });
  await page.waitForTimeout(1500);

  // ============ 验证 ① 顺序 ============
  // 失败 row 用 .chat-msg-failed 标识；其它 row 用 .tx-row 顺序枚举正文。
  const order = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".chat-msgs .tx-row"));
    return rows.map((r) => {
      const failed = r.querySelector(".chat-msg-failed");
      if (failed) return `FAIL:${(failed.querySelector(".tx-text")?.textContent ?? "").trim()}`;
      const text = (r.querySelector(".tx-text")?.textContent ?? "").trim();
      return text;
    });
  });
  console.log("rendered order:", order);

  const expected = ["msg-1", "reply-1", "msg-2 这条会失败", "FAIL:claude exit 1 (network)", "msg-3 重试", "reply-3 OK"];
  if (JSON.stringify(order) !== JSON.stringify(expected)) {
    throw new Error(`order mismatch.\nexpected: ${JSON.stringify(expected)}\n  actual: ${JSON.stringify(order)}`);
  }
  console.log("✓ 顺序正确：失败条插在 msg-2 之后、msg-3 之前");

  await page.screenshot({ path: path.join(__dirname, "..", "round-1-order.png"), fullPage: false });

  // ============ 验证 ② 自动滚动（粘底） ============
  // 先确认 chat-msgs 真的有内容溢出（否则 scrollTop=0 测不到「不拽底」）。
  const sizes = await page.evaluate(() => {
    const el = document.querySelector(".chat-msgs");
    return { height: el.scrollHeight, client: el.clientHeight };
  });
  console.log("chat-msgs sizes:", sizes);
  if (sizes.height <= sizes.client + 20) {
    throw new Error(`chat-msgs 没有 overflow（height=${sizes.height} client=${sizes.client}），测不出粘底逻辑`);
  }

  // 滚到顶端 → 等 4s（>3s 轮询周期）→ 校验 scrollTop 未被拉回底部。
  await page.evaluate(() => {
    const el = document.querySelector(".chat-msgs");
    if (!el) throw new Error("no .chat-msgs");
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(4500);
  const scrollTopAfterPoll = await page.evaluate(() => {
    const el = document.querySelector(".chat-msgs");
    return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
  });
  console.log("after 4.5s poll, scroll metrics:", scrollTopAfterPoll);
  if (scrollTopAfterPoll.top > 64) {
    throw new Error(`scrollTop 被自动拽回（${scrollTopAfterPoll.top}px），粘底逻辑没生效`);
  }
  console.log("✓ 用户翻到顶后，轮询不会自动拽回底部");

  await browser.close();
}

try {
  await waitReady();
  const ids = await seedAndDrive();
  await captureAndAssert(ids);
  console.log("\n✓ ALL PASS");
} catch (e) {
  console.error("[error]", e);
  process.exitCode = 1;
} finally {
  child.kill();
}
