// P2 端到端：boot console 对临时库 → 登录 → 对话 REST（建/列/详情/发消息/关）→ 模拟 worker 写分片 + NOTIFY
// → 读 SSE 断言收到流式 delta + done。验证 LISTEN/NOTIFY → SSE → 客户端整条实时链路（无需真 worker/claude）。
// 跑法：node docs/acceptance/worker-direct-chat/scripts/verify-api-sse.mjs
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  appendConversationChunk,
  claimNextConversationTurn,
  closePool,
  finalizeConversationTurn,
  notifyConversationChunk
} from "@claude-center/db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const baseDbUrl = process.env.DATABASE_URL;
if (!baseDbUrl) throw new Error("DATABASE_URL required");

const url = new URL(baseDbUrl);
const dbName = `cc_dchat_apisse_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

let failures = 0;
const assert = (cond, msg) => { if (cond) console.log(`  PASS  ${msg}`); else { failures += 1; console.error(`  FAIL  ${msg}`); } };
const withClient = async (u, fn) => { const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(String(p))); }); });

let created = false;
let child = null;
const pool = new pg.Pool({ connectionString: targetUrl.toString() });
try {
  // 临时库 + 全量迁移
  await withClient(adminUrl, async (c) => { await c.query(`CREATE DATABASE "${dbName}"`); });
  created = true;
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const f of files) { await c.query(await readFile(path.join(migrationsDir, f), "utf8")); await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]); }
    await c.query("COMMIT");
  });
  console.log("✓ ephemeral db migrated");

  // 种子：项目 + worker + 关联（admin 用户由迁移 008 引导，admin/admin123）
  const projectId = (await pool.query(`INSERT INTO projects (name, repo_url, default_branch) VALUES ('p','https://x/p','main') RETURNING id`)).rows[0].id;
  const workerId = (await pool.query(`INSERT INTO workers (id, name, host_name, status) VALUES (gen_random_uuid(),'w','h','online') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO worker_project_links (worker_id, project_id, local_path, repo_identity) VALUES ($1,$2,'D:/repos/p','p')`, [workerId, projectId]);

  // boot console（next dev）对临时库
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  const consoleDir = path.join(root, "apps", "console");
  const dotNext = path.join(consoleDir, ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });
  let out = "";
  child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", port], {
    cwd: consoleDir, windowsHide: true, env: { ...process.env, DATABASE_URL: targetUrl.toString() }
  });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`console 未就绪\n${out.slice(-2000)}`)), 40000);
    const iv = setInterval(() => { if (out.includes("Ready in")) { clearTimeout(to); clearInterval(iv); res(); } }, 250);
    child.on("exit", (c) => { clearTimeout(to); clearInterval(iv); rej(new Error(`console 退出 ${c}\n${out.slice(-2000)}`)); });
  });
  console.log(`✓ console ready on ${port}`);

  // 登录拿 cookie
  const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin123" }) });
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert(login.ok && token, "admin 登录拿到 cc_session cookie");
  const cookie = `cc_session=${token}`;
  const J = (extra) => ({ "Content-Type": "application/json", cookie, ...extra });

  // REST：建对话
  const createRes = await fetch(`${base}/api/conversations`, { method: "POST", headers: J(), body: JSON.stringify({ projectId, workerId, branch: "main", model: "default", title: "API 测试" }) });
  const createBody = await createRes.json();
  assert(createRes.status === 201 && createBody.conversation?.id, "POST /api/conversations → 201 建会话");
  const convId = createBody.conversation.id;

  // 未关联项目的 worker → 400
  const badWorker = (await pool.query(`INSERT INTO workers (id, name, host_name) VALUES (gen_random_uuid(),'w2','h') RETURNING id`)).rows[0].id;
  const badRes = await fetch(`${base}/api/conversations`, { method: "POST", headers: J(), body: JSON.stringify({ projectId, workerId: badWorker, branch: "main" }) });
  assert(badRes.status === 400, "未关联项目的 worker 建对话 → 400");

  // 列表
  const listRes = await fetch(`${base}/api/conversations`, { headers: { cookie } });
  const listBody = await listRes.json();
  assert(listRes.ok && listBody.conversations.some((c) => c.id === convId), "GET /api/conversations 列表含新会话");

  // 未登录 → 401
  const unauth = await fetch(`${base}/api/conversations`);
  assert(unauth.status === 401, "未登录 GET /api/conversations → 401");

  // 发用户消息
  const msgRes = await fetch(`${base}/api/conversations/${convId}/messages`, { method: "POST", headers: J(), body: JSON.stringify({ body: "你好" }) });
  assert(msgRes.status === 201, "POST .../messages → 201 发用户消息");

  // 打开 SSE 并后台读取，收集 delta/done
  const ac = new AbortController();
  const sseEvents = [];
  let sawOpen = false, sawDone = false;
  const sseDone = (async () => {
    const res = await fetch(`${base}/api/conversations/${convId}/stream`, { headers: { cookie }, signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) ev.event = line.slice(6).trim();
            else if (line.startsWith("data:")) ev.data = line.slice(5).trim();
          }
          if (ev.event === "open") sawOpen = true;
          if (ev.event === "delta") sseEvents.push(JSON.parse(ev.data));
          if (ev.event === "done") { sawDone = true; ev.parsed = JSON.parse(ev.data); sseEvents.push(ev); return; }
        }
      }
    } catch { /* aborted */ }
  })();

  // 等 SSE 连上（拿到 open）
  for (let i = 0; i < 40 && !sawOpen; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert(sawOpen, "SSE 连接收到 open 事件");

  // 模拟 worker：领取本轮 → 写 3 片 + NOTIFY → 收尾
  const turn = await claimNextConversationTurn(pool, workerId);
  assert(turn && turn.status === "streaming", "worker 模拟：认领到 assistant streaming 轮");
  for (let s = 0; s < 3; s += 1) {
    await appendConversationChunk(pool, { messageId: turn.id, seq: s, delta: `片${s} ` });
    await notifyConversationChunk(pool, { conversationId: convId, messageId: turn.id, seq: s });
  }
  await finalizeConversationTurn(pool, { conversationId: convId, messageId: turn.id, body: "片0 片1 片2 ", sessionId: "sess-x" });
  await notifyConversationChunk(pool, { conversationId: convId, messageId: turn.id, seq: -1 });

  // 等 SSE 收到 delta + done（NOTIFY 即时；2s 慢轮询兜底）
  await Promise.race([sseDone, new Promise((r) => setTimeout(r, 8000))]);
  ac.abort();
  const deltas = sseEvents.filter((e) => e.delta);
  assert(deltas.length >= 3, `SSE 收到 ${deltas.length} 个 delta（流式 token 推达浏览器）`);
  assert(deltas.map((d) => d.delta).join("") === "片0 片1 片2 ", "SSE delta 拼接 = 最终文本");
  assert(sawDone, "SSE 收到 done 事件");

  // 关闭对话
  const closeRes = await fetch(`${base}/api/conversations/${convId}/close`, { method: "POST", headers: J() });
  assert(closeRes.ok, "POST .../close → 结束对话");
  const detail = await (await fetch(`${base}/api/conversations/${convId}`, { headers: { cookie } })).json();
  assert(detail.conversation.status === "closed", "GET 详情 → status=closed");
} finally {
  if (child) child.kill();
  try { await closePool(); } catch { /* ignore */ }
  await pool.end().catch(() => {});
  if (created) await withClient(adminUrl, async (c) => { await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }).catch(() => {});
  console.log("✓ cleaned up");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
