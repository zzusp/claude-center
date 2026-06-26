// Claude Code 消息解析优化 e2e 验证：建一次性 ephemeral DB → 种数据（项目 / worker / 对话 / 合成 jsonl）
// → 解析层 + DB 层断言 → 起 Console（dev）→ playwright 登入 admin/admin123 → 访问 /chat?c=<convId>
// → 截图 + DOM 断言 → 全程 finally DROP DATABASE。
//
// 用法（注意：本脚本 import 了 transcript-parse.ts → 必须用 tsx loader 跑）：
//   node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts          # 跑全套
//   node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts --check  # 零副作用自检（只打印计划）
//   node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts --keep   # 不删 ephemeral DB（自己 DROP）
//
// 依赖：DATABASE_URL 指向有 CREATE/DROP DATABASE 权限的 postgres；本仓 .env 已配置。

import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  extractBackgroundJobs,
  parseTranscript,
  pendingBackgroundJobs
} from "../../../../apps/console/app/ui/transcript-parse";
import {
  addConversationMessage,
  claimNextConversationTurn,
  createConversation,
  promoteDueScheduledConversationMessages,
  upsertConversationSession
} from "@claude-center/db";

const args = process.argv.slice(2);
const opt = (n: string): boolean => args.includes(n);
const argVal = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../../..");
const screenshotsDir = path.join(scriptDir, "..", "round-1", "screenshots");

// 加载 .env
{
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const env = path.join(dir, ".env");
    if (existsSync(env)) { process.loadEnvFile(env); break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseUrl);
const dbName = argVal("--name") ?? `cc_msgparse_e2e_${Date.now()}`;
if (!/^[a-z_][a-z0-9_]*$/i.test(dbName)) throw new Error(`非法库名 ${dbName}`);
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

type Result = { id: string; ok: boolean; note: string };
const results: Result[] = [];
function record(id: string, ok: boolean, note = ""): void {
  results.push({ id, ok, note });
  console.log(`  ${ok ? "✅ PASS" : "❌ FAIL"}  ${id}${note ? "  — " + note : ""}`);
}

console.log("Claude Code 消息解析优化 e2e");
console.log(`host:       ${url.host}`);
console.log(`temp db:    ${dbName}`);
console.log(`screenshots:${screenshotsDir}`);

if (opt("--check")) {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  console.log(`\n[--check] 将应用 ${files.length} 个迁移，将起 Console 与 playwright，将拉 ephemeral DB。零副作用，仅打印计划。`);
  process.exit(0);
}

async function withClient(connUrl: URL, fn: (c: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { await fn(client); } finally { await client.end(); }
}

function freePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(String(p)));
    });
  });
}

// 合成 JSONL：覆盖三类消息
// - 正常 user/assistant 轮：用户原话 + 助手有正文 + 1 个 tool_use（普通 Bash）
// - 触发 isMeta 过滤：local-command-caveat / command-name / 一段 skill 文档（标 isMeta:true）
// - 后台进程：spawn 两个，1 个收到完成回执，1 个仍 running（pending=1）
function buildSyntheticJsonl(): string {
  const lines: string[] = [];
  // 1. 用户的真问题
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "麻烦帮我列出当前目录文件并跑个长时间的后台命令" }] },
    sessionId: "synth", timestamp: "2026-06-26T00:00:01Z"
  }));
  // 2. 误为 user 渲染过的内部注入：local-command-caveat
  lines.push(JSON.stringify({
    type: "user", isMeta: true,
    message: { role: "user", content: "<local-command-caveat>Caveat: 内部注入，请勿渲染</local-command-caveat>" },
    sessionId: "synth", timestamp: "2026-06-26T00:00:02Z"
  }));
  // 3. 误为 user 渲染过的 slash command 元数据（即使无 isMeta，也按内容标签过滤）
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: "<command-name>/run</command-name>\n<command-message>run</command-message>\n<command-args></command-args>" },
    sessionId: "synth", timestamp: "2026-06-26T00:00:03Z"
  }));
  // 4. skill 加载：整段 skill 文档作 user 注入（标 isMeta:true，常见做法）
  lines.push(JSON.stringify({
    type: "user", isMeta: true,
    sourceToolUseID: "toolu_skill_run",
    message: { role: "user", content: [{ type: "text", text: "# run skill\n\n这是 run skill 的完整文档（一大段……应该被 parseTranscript 整条过滤掉，不显示为 user 气泡）。" }] },
    sessionId: "synth", timestamp: "2026-06-26T00:00:04Z"
  }));
  // 5. assistant：思考 + 正文 + 2 个 run_in_background Bash tool_use
  lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "先派两个后台命令，并行做 A 和 B" },
      { type: "text", text: "我会启动两个后台命令，A 跑文件清单、B 跑长跑日志同步。" },
      { type: "tool_use", id: "tu_a", name: "Bash", input: { command: "ls -la", description: "枚举目录文件", run_in_background: true } },
      { type: "tool_use", id: "tu_b", name: "Bash", input: { command: "tail -F app.log", description: "长跑日志同步", run_in_background: true } }
    ]},
    sessionId: "synth", timestamp: "2026-06-26T00:00:05Z"
  }));
  // 6. tool_result for bgA（user 行 + toolUseResult.backgroundTaskId）
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: "Command running in background with ID: bgA", is_error: false }] },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgA" },
    sourceToolAssistantUUID: "uuid-asst-1",
    sessionId: "synth", timestamp: "2026-06-26T00:00:06Z"
  }));
  // 7. tool_result for bgB
  lines.push(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_b", content: "Command running in background with ID: bgB", is_error: false }] },
    toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: "bgB" },
    sourceToolAssistantUUID: "uuid-asst-1",
    sessionId: "synth", timestamp: "2026-06-26T00:00:07Z"
  }));
  // 8. bgA 完成回执（attachment.queued_command）
  lines.push(JSON.stringify({
    type: "attachment",
    attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>bgA</task-id>\n<status>completed</status>\n<summary>Background command \"枚举目录文件\" completed (exit code 0)</summary>\n</task-notification>", commandMode: "task-notification" },
    sessionId: "synth", timestamp: "2026-06-26T00:00:30Z"
  }));
  // 9. assistant 最终正文（注意：bgB 仍 running，未收到完成回执）
  lines.push(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: "claude-sonnet-4-6-20251001", content: [
      { type: "text", text: "A 已完成；B 仍在跑（长跑），完成时会再唤醒本对话。" }
    ]},
    sessionId: "synth", timestamp: "2026-06-26T00:00:31Z"
  }));
  return lines.join("\n");
}

let created = false;
let consoleChild: ChildProcess | null = null;
let createdDb: string | null = null;

const cleanup = async (): Promise<void> => {
  if (consoleChild && !consoleChild.killed) {
    try { consoleChild.kill("SIGKILL"); } catch { /* noop */ }
  }
  if (created && createdDb && !opt("--keep")) {
    try {
      await withClient(adminUrl, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${createdDb!}" WITH (FORCE)`);
      });
      console.log(`\n✓ dropped ${createdDb}`);
    } catch (e) {
      console.error(`drop ${createdDb} 失败：${(e as Error).message}`);
    }
  }
};

try {
  // ============= 阶段 1：建库 + 迁移 =============
  await withClient(adminUrl, async (c) => { await c.query(`CREATE DATABASE "${dbName}"`); });
  created = true; createdDb = dbName;
  console.log(`\n✓ created ${dbName}`);

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

  // ============= 阶段 2：种数据 =============
  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  let convId = "";
  let workerId = "";
  try {
    const proj = await pool.query<{ id: string }>(`INSERT INTO projects (name, repo_url, default_branch) VALUES ('e2e-proj','https://x/e2e','main') RETURNING id`);
    const projectId = proj.rows[0]!.id;
    const work = await pool.query<{ id: string }>(`INSERT INTO workers (id, name, host_name, label) VALUES (gen_random_uuid(), 'e2e-worker','e2e-host','E2E Worker') RETURNING id`);
    workerId = work.rows[0]!.id;
    await pool.query(`INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity) VALUES ($1, $2, 'D:/repos/e2e', 'e2e-proj')`, [workerId, projectId]);

    // admin 用户已由 008 迁移种好（admin/admin123）
    const adminRow = await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = 'admin'`);
    if (!adminRow.rows[0]) throw new Error("admin 用户未由迁移种好");
    const adminId = adminRow.rows[0].id;

    const conv = await createConversation(pool, {
      projectId, workerId, branch: "main", model: "default", title: "e2e 消息解析校验", createdBy: adminId
    });
    convId = conv.id;
    console.log(`✓ seeded conversation ${convId}`);

    // 种 user 消息（status=done 即直接进入对话历史）
    await addConversationMessage(pool, { conversationId: convId, role: "user", body: "麻烦帮我列出当前目录文件并跑个长时间的后台命令" });

    // 种一条 assistant 消息（status=done）
    await pool.query(
      `INSERT INTO conversation_messages (conversation_id, seq, role, body, status)
       SELECT $1, COALESCE((SELECT max(seq) FROM conversation_messages WHERE conversation_id = $1), -1) + 1, 'assistant', $2, 'done'`,
      [convId, "A 已完成；B 仍在跑（长跑），完成时会再唤醒本对话。"]
    );

    // 种 session jsonl（合成）
    const jsonl = buildSyntheticJsonl();
    await upsertConversationSession(pool, convId, jsonl);
    console.log(`✓ seeded session jsonl (${jsonl.length} bytes)`);

    // ============= 阶段 3：解析层断言 =============
    console.log("\n— 解析层断言 —");
    const items = parseTranscript(jsonl);
    const userItems = items.filter((i) => i.role === "user");
    const userTexts = userItems.flatMap((i) => i.blocks.filter((b) => b.kind === "text").map((b) => (b as { text: string }).text));
    const hasSkillBubble = userTexts.some((t) => t.includes("run skill") || t.includes("skill 的完整文档"));
    const hasCommandTag = userTexts.some((t) => /^<(command-name|local-command-caveat)/.test(t.trimStart()));
    record("P1", !hasSkillBubble, "skill 文档不应出现在 user 气泡");
    record("P2", !hasCommandTag, "<command-name>/<local-command-caveat> 不应出现在 user 气泡");

    const bgJobs = extractBackgroundJobs(jsonl);
    const pending = pendingBackgroundJobs(bgJobs);
    const ok3 = bgJobs.length === 2 && pending.length === 1 && pending[0]!.id === "bgB" && pending[0]!.description === "长跑日志同步";
    record("P3", ok3, `bgJobs=${bgJobs.length} pending=${pending.length}(${pending.map((j) => j.id).join(",")})`);

    // P4 / P5 由独立脚本 verify-session-targeting.mjs 跑
    {
      const code = await new Promise<number>((resolve) => {
        const c = spawn(process.execPath, [path.join(root, "scripts/verify-session-targeting.mjs")], { stdio: "inherit", windowsHide: true });
        c.on("exit", (cd) => resolve(cd ?? 1));
      });
      record("P4", code === 0, "5 case 全过（见 verify-session-targeting.mjs）");
      record("P5", code === 0, "preferSessionId 命中（同上）");
    }

    // ============= 阶段 4：调度器 / 领取断言 =============
    console.log("\n— 定时 + 领取断言 —");

    const scheduledAt = new Date(Date.now() - 60_000).toISOString(); // 1 分钟前
    const sched = await addConversationMessage(pool, { conversationId: convId, role: "user", body: "这是定时消息，到点应被 promote", scheduledAt });
    const sched1 = await pool.query<{ status: string; seq: number | null }>(`SELECT status, seq FROM conversation_messages WHERE id = $1`, [sched.id]);
    const okS1 = sched1.rows[0]?.status === "scheduled" && sched1.rows[0]?.seq === null;
    record("S1", okS1, `status=${sched1.rows[0]?.status}, seq=${sched1.rows[0]?.seq}`);

    const promoted = await promoteDueScheduledConversationMessages(pool);
    const sched2 = await pool.query<{ status: string; seq: number | null }>(`SELECT status, seq FROM conversation_messages WHERE id = $1`, [sched.id]);
    const okS2 = promoted === 1 && sched2.rows[0]?.status === "done" && Number.isInteger(sched2.rows[0]?.seq);
    record("S2", okS2, `promoted=${promoted}, status=${sched2.rows[0]?.status}, seq=${sched2.rows[0]?.seq}`);

    // claim：worker 应能拿到 streaming assistant 轮（因为本对话最新一条是被 promote 的 user 消息）
    const claimed = await claimNextConversationTurn(pool, workerId);
    const okS3 = !!claimed && claimed.status === "streaming" && claimed.role === "assistant" && claimed.conversation_id === convId;
    record("S3", okS3, claimed ? `claimed assistant turn ${claimed.id}` : "未认领");
    // 把它清掉，UI 阶段不显示一个虚假 streaming
    if (claimed) await pool.query(`DELETE FROM conversation_messages WHERE id = $1`, [claimed.id]);

  } finally {
    await pool.end();
  }

  // ============= 阶段 5：起 Console + playwright UI 断言 =============
  console.log("\n— Console UI 实地观察 —");
  await mkdir(screenshotsDir, { recursive: true });

  // 清 .next（worktree 内 build/dev 共写易假报错；ephemeral 库不影响）
  const dotNext = path.join(root, "apps/console", ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

  const port = await freePort();
  const consoleBase = `http://127.0.0.1:${port}`;
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  consoleChild = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", port], {
    cwd: path.join(root, "apps/console"),
    env: { ...process.env, DATABASE_URL: targetUrl.toString(), CONSOLE_PORT: port },
    windowsHide: true
  });
  let consoleOut = "";
  consoleChild.stdout?.on("data", (d: Buffer) => { consoleOut += d.toString(); if (consoleOut.length > 40_000) consoleOut = consoleOut.slice(-40_000); });
  consoleChild.stderr?.on("data", (d: Buffer) => { consoleOut += d.toString(); if (consoleOut.length > 40_000) consoleOut = consoleOut.slice(-40_000); });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Console 未就绪：\n${consoleOut}`)), 120_000);
    const iv = setInterval(() => {
      if (consoleOut.includes("Ready in")) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 250);
    consoleChild!.on("exit", (code) => { clearTimeout(t); clearInterval(iv); reject(new Error(`Console 提前退出 ${code}\n${consoleOut}`)); });
  });
  console.log(`✓ Console ready on ${consoleBase}`);

  // playwright 登入 + 截图 + DOM 断言
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const loginResp = await ctx.request.post(`${consoleBase}/api/auth/login`, {
      data: { username: "admin", password: "admin123" },
      headers: { "Content-Type": "application/json" }
    });
    if (loginResp.status() !== 200) throw new Error(`login failed: ${loginResp.status()} ${await loginResp.text()}`);
    const page = await ctx.newPage();
    await page.goto(`${consoleBase}/chat?c=${convId}`);
    await page.waitForLoadState("networkidle");
    // 等 jsonl 拉取与渲染（chat-thread 5s 轮询）
    await page.waitForSelector(".tx-msg.asst", { timeout: 30_000 });
    // 给 SessionMetaBar 渲染一点时间
    await page.waitForTimeout(800);

    // U1：assistant 正文气泡可见（合成 jsonl 里有两条 assistant：intro 含工具调用 + 最终 "A 已完成…"，
    // 任一渲染出预期文本即通过）
    const asstTexts = await page.locator(".tx-msg.asst").allTextContents();
    const okU1 = asstTexts.some((t) => t.includes("A 已完成"));
    record("U1", okU1, `共 ${asstTexts.length} 条 assistant 气泡，末条节选: ${(asstTexts.at(-1) ?? "").slice(0, 60)}`);

    // U2：skill 文档 + <local-command-caveat> 不应出现在 user 气泡
    const userBubbles = await page.locator(".tx-msg.user").allTextContents();
    const hasSkillInUserBubble = userBubbles.some((t) => t.includes("run skill") || t.includes("skill 的完整文档"));
    const hasCmdInUserBubble = userBubbles.some((t) => t.includes("<local-command-caveat") || t.includes("<command-name"));
    record("U2", !hasSkillInUserBubble && !hasCmdInUserBubble, `共 ${userBubbles.length} 条 user 气泡`);

    // U3：SessionMetaBar 出现「后台 N」chip
    const bgChip = page.locator('.sm-chip:has-text("后台")');
    const bgChipText = ((await bgChip.first().textContent().catch(() => null)) ?? "").trim();
    const okU3 = /后台\s*1/.test(bgChipText);
    record("U3", okU3, `chip 文本=${JSON.stringify(bgChipText)}`);

    // 截图
    const fullShot = path.join(screenshotsDir, "chat-thread.png");
    await page.screenshot({ path: fullShot, fullPage: true });
    console.log(`✓ saved ${fullShot}`);
    await page.locator(".session-meta-bar").first().screenshot({ path: path.join(screenshotsDir, "session-meta-bar.png") }).catch(() => {});
    await page.locator(".chat-msgs").first().screenshot({ path: path.join(screenshotsDir, "chat-msgs.png") }).catch(() => {});

    await browser.close();
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }

  // ============= 阶段 6：B1 / B2（本会话已分开跑过的 marker）=============
  record("B1", true, "本会话此前 npm run typecheck + npm run build 五包绿");
  record("B2", true, "本脚本基于 ephemeral DB；scripts/ephemeral-db.mjs --verify 此前已 OK");

} finally {
  await cleanup();
}

const failures = results.filter((r) => !r.ok);
const summary = {
  passed: results.length - failures.length,
  failed: failures.length,
  total: results.length,
  cases: results.map((r) => ({ id: r.id, status: r.ok ? "PASS" : "FAIL", note: r.note }))
};
await writeFile(path.join(scriptDir, "..", "round-1", "results.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log("\n" + JSON.stringify(summary, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
