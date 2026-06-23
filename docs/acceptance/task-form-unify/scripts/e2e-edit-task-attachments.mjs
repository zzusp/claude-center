// E2E：编辑任务表单的「附件」字段——未发布前可增可删，走真实路由整批同步。
// 全链路真跑：临时库 → 起 console dev → 登录 → 建项目 → 上传附件 → 建草稿任务(带 attachmentIds) →
//   PATCH /api/tasks/{id} action=update（带 attachmentIds，模拟编辑表单提交：保留+新增+移除）→
//   GET /api/tasks/{id} 断言 task.attachments 随之增删；被移除的附件行真被删除（GET 二进制 404）。
// 验证的是本次新接的数据契约：编辑表单序列化的 attachmentIds[] → 后端 syncTaskAttachments 差异增删。
//
// 用法（DATABASE_URL 指向可建库的 PG 实例；临时库零污染，用完 DROP）：
//   node docs/acceptance/task-form-unify/scripts/e2e-edit-task-attachments.mjs
import { readdir, readFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))));

// 加载最近的 .env（与 ephemeral-db.mjs 一致），允许直接 node 跑。
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

const baseDbUrl = process.env.DATABASE_URL;
if (!baseDbUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseDbUrl);
const dbName = `cc_e2e_attach_${Date.now()}`;
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
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

let created = false;
let child = null;
try {
  // 1) 建库 + 全量迁移（含 008 引导管理员 admin/admin123）。
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  console.log(`✓ created ${dbName}`);
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

  // 2) 起 console dev（独立空闲端口 + 临时库）。
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const consoleDir = path.join(root, "apps", "console");
  const dotNext = path.join(consoleDir, ".next");
  if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  let output = "";
  child = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", "127.0.0.1", "--port", port], {
    cwd: consoleDir,
    env: { ...process.env, DATABASE_URL: targetUrl.toString() },
    windowsHide: true
  });
  child.stdout.on("data", (d) => (output += d.toString("utf8")));
  child.stderr.on("data", (d) => (output += d.toString("utf8")));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`console 未就绪:\n${output.slice(-2000)}`)), 120_000);
    const interval = setInterval(() => {
      if (output.includes("Ready in")) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 250);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`console 退出码 ${code}:\n${output.slice(-2000)}`));
    });
  });
  console.log(`✓ console ready on ${baseUrl}`);

  // 3) 登录拿 cookie。
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  assert(login.ok, `登录失败 ${login.status}: ${await login.text()}`);
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  assert(token, "登录未返回 cc_session");
  const cookie = `cc_session=${token}`;
  console.log("✓ logged in");

  async function api(method, p, body) {
    const res = await fetch(`${baseUrl}${p}`, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, json };
  }

  // 上传一个 text/plain 附件，返回 attachment id（kind=file，避开图片 magic 强校验）。
  async function upload(name) {
    const form = new FormData();
    form.append("file", new Blob([`content of ${name}`], { type: "text/plain" }), name);
    const res = await fetch(`${baseUrl}/api/attachments`, { method: "POST", headers: { cookie }, body: form });
    const json = await res.json();
    assert(res.status === 201, `上传 ${name} 失败 ${res.status}: ${JSON.stringify(json)}`);
    return json.attachment.id;
  }

  // 4) 建项目（git）。
  const proj = await api("POST", "/api/projects", {
    name: "E2E Attach",
    repoUrl: "https://example.invalid/main.git",
    defaultBranch: "main",
    description: ""
  });
  assert(proj.status === 201, `建项目失败 ${proj.status}: ${JSON.stringify(proj.json)}`);
  const projectId = proj.json.project.id;
  console.log(`✓ project created (${projectId})`);

  // 5) 上传 2 个附件 + 建草稿任务（带 attachmentIds）。
  const a1 = await upload("a1.txt");
  const a2 = await upload("a2.txt");
  const createdTask = await api("POST", "/api/tasks", {
    projectId,
    title: "attach edit e2e",
    description: "verify edit form attachment sync",
    baseBranch: "main",
    workBranch: "cc/attach-e2e",
    targetBranch: "main",
    submitMode: "pr",
    model: "default",
    attachmentIds: [a1, a2]
  });
  assert(createdTask.status === 201, `建任务失败 ${createdTask.status}: ${JSON.stringify(createdTask.json)}`);
  const taskId = createdTask.json.task.id;

  const idsOf = (detail) => (detail.json.task.attachments ?? []).map((a) => a.id).sort();

  let detail = await api("GET", `/api/tasks/${taskId}`);
  assert(detail.status === 200, `取任务详情失败 ${detail.status}`);
  assert(detail.json.task.status === "draft", `任务应为草稿(未发布)，实际 ${detail.json.task.status}`);
  assert(JSON.stringify(idsOf(detail)) === JSON.stringify([a1, a2].sort()), `初始附件应为 {a1,a2}，实际 ${idsOf(detail)}`);
  console.log("✓ 新建任务带 2 附件，详情正确返回 task.attachments");

  // 6) 编辑：保留 a2、移除 a1、新增 a3（模拟编辑表单 attachmentIds = [a2, a3]）。
  const a3 = await upload("a3.txt");
  const updBody = {
    action: "update",
    title: "attach edit e2e",
    description: "verify edit form attachment sync",
    baseBranch: "main",
    workBranch: "cc/attach-e2e",
    targetBranch: "main",
    submitMode: "pr",
    model: "default",
    attachmentIds: [a2, a3]
  };
  const upd = await api("PATCH", `/api/tasks/${taskId}`, updBody);
  assert(upd.status === 200, `编辑保存失败 ${upd.status}: ${JSON.stringify(upd.json)}`);

  detail = await api("GET", `/api/tasks/${taskId}`);
  assert(JSON.stringify(idsOf(detail)) === JSON.stringify([a2, a3].sort()), `编辑后附件应为 {a2,a3}，实际 ${idsOf(detail)}`);
  console.log("✓ 编辑表单 保留+新增+移除 → task.attachments 同步正确");

  // 被移除的 a1 应已被删除（二进制端点 404）。
  const goneA1 = await fetch(`${baseUrl}/api/attachments/${a1}`, { headers: { cookie } });
  assert(goneA1.status === 404, `被移除附件 a1 应已删除(404)，实际 ${goneA1.status}`);
  console.log("✓ 被移除的附件行真被删除（二进制 404）");

  // 7) 再次编辑清空所有附件（attachmentIds=[]）→ task.attachments 为空，a2/a3 被删。
  const upd2 = await api("PATCH", `/api/tasks/${taskId}`, { ...updBody, attachmentIds: [] });
  assert(upd2.status === 200, `清空附件保存失败 ${upd2.status}: ${JSON.stringify(upd2.json)}`);
  detail = await api("GET", `/api/tasks/${taskId}`);
  assert(idsOf(detail).length === 0, `清空后附件应为空，实际 ${idsOf(detail)}`);
  const goneA2 = await fetch(`${baseUrl}/api/attachments/${a2}`, { headers: { cookie } });
  const goneA3 = await fetch(`${baseUrl}/api/attachments/${a3}`, { headers: { cookie } });
  assert(goneA2.status === 404 && goneA3.status === 404, `清空后 a2/a3 应删除(404)，实际 ${goneA2.status}/${goneA3.status}`);
  console.log("✓ 编辑清空附件 → 全部移除并删除");

  // 8) 不带 attachmentIds 字段的编辑保持原附件不动（undefined=不同步）。先恢复一个附件再验。
  const a4 = await upload("a4.txt");
  await api("PATCH", `/api/tasks/${taskId}`, { ...updBody, attachmentIds: [a4] });
  const updNoAttach = await api("PATCH", `/api/tasks/${taskId}`, {
    action: "update",
    title: "attach edit e2e v2",
    description: "verify edit form attachment sync",
    baseBranch: "main",
    workBranch: "cc/attach-e2e",
    targetBranch: "main",
    submitMode: "pr",
    model: "default"
    // 注意：不带 attachmentIds
  });
  assert(updNoAttach.status === 200, `不带附件字段编辑失败 ${updNoAttach.status}: ${JSON.stringify(updNoAttach.json)}`);
  detail = await api("GET", `/api/tasks/${taskId}`);
  assert(JSON.stringify(idsOf(detail)) === JSON.stringify([a4]), `不带 attachmentIds 编辑应保留原附件 {a4}，实际 ${idsOf(detail)}`);
  console.log("✓ 不带 attachmentIds 的编辑保持原附件不动（兼容旧前端）");

  console.log("ALL E2E CHECKS PASSED");
} finally {
  if (child) child.kill();
  if (created) {
    // 给 console 释放连接一点时间，避免 DROP 撞活动连接（WITH FORCE 也会强断）。
    await new Promise((r) => setTimeout(r, 500));
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`✓ dropped ${dbName}`);
  }
}
