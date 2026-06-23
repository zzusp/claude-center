// E2E：编辑任务表单填写/修改子仓（子项目）信息，整批落库到 task_repos。
// 全链路真跑：临时库 → 起 console dev → 登录 → 建项目+子仓 → 建草稿任务 →
//   走真实路由 PATCH /api/tasks/{id} action=update（带 taskRepos，模拟编辑表单提交）→
//   GET /api/tasks/{id} 断言 task_repos 快照随之翻转（启用/分支/再禁用）。
// 验证的是编辑表单新接的数据契约：表单序列化的 taskRepos[] → 后端整批替换 task_repos。
//
// 用法（DATABASE_URL 指向可建库的 PG 实例；临时库零污染，用完 DROP）：
//   node docs/acceptance/task-edit-subrepos/scripts/e2e-edit-task-subrepos.mjs
import { readdir, readFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))));

const baseDbUrl = process.env.DATABASE_URL;
if (!baseDbUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseDbUrl);
const dbName = `cc_e2e_editsub_${Date.now()}`;
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

  // 4) 建项目 + 一个子仓。
  const proj = await api("POST", "/api/projects", {
    name: "E2E EditSub",
    repoUrl: "https://example.invalid/main.git",
    defaultBranch: "main",
    description: ""
  });
  assert(proj.status === 201, `建项目失败 ${proj.status}: ${JSON.stringify(proj.json)}`);
  const projectId = proj.json.project.id;

  const repos = await api("PUT", `/api/projects/${projectId}/repos`, {
    subs: [{ name: "widgets", repoUrl: "https://example.invalid/widgets.git", defaultBranch: "main", description: "", position: 1 }]
  });
  assert(repos.status === 200, `写子仓失败 ${repos.status}: ${JSON.stringify(repos.json)}`);
  const sub = repos.json.repos.find((r) => r.role === "sub");
  assert(sub, "应能查到子仓行");
  console.log(`✓ project + sub repo created (subId=${sub.id})`);

  // 5) 建草稿任务（不带 taskRepos → 子仓默认 skipped）。
  const created2 = await api("POST", "/api/tasks", {
    projectId,
    title: "edit sub e2e",
    description: "verify edit form subrepo config",
    baseBranch: "main",
    workBranch: "cc/edit-sub-e2e",
    targetBranch: "main",
    submitMode: "pr",
    model: "default"
  });
  assert(created2.status === 201, `建任务失败 ${created2.status}: ${JSON.stringify(created2.json)}`);
  const taskId = created2.json.task.id;

  const subRepoOf = (taskRepos) => taskRepos.find((tr) => tr.project_repo_id === sub.id);

  let detail = await api("GET", `/api/tasks/${taskId}`);
  assert(detail.status === 200, `取任务详情失败 ${detail.status}`);
  let trSub = subRepoOf(detail.json.taskRepos);
  assert(trSub, "任务应有该子仓的 task_repos 行");
  assert(trSub.sub_status === "skipped", `初始子仓应为 skipped，实际 ${trSub.sub_status}`);
  console.log("✓ 新建任务默认子仓 skipped（未启用）");

  // 6) 模拟编辑表单：启用子仓 + 自定义三分支（serializeTaskRepos 产出的形状）。
  const updateBody = {
    action: "update",
    title: "edit sub e2e",
    description: "verify edit form subrepo config",
    baseBranch: "main",
    workBranch: "cc/edit-sub-e2e",
    targetBranch: "main",
    submitMode: "pr",
    model: "default",
    taskRepos: [
      { projectRepoId: sub.id, baseBranch: "dev", workBranch: "cc/widgets-x", targetBranch: "release", enabled: true }
    ]
  };
  const upd = await api("PATCH", `/api/tasks/${taskId}`, updateBody);
  assert(upd.status === 200, `编辑保存失败 ${upd.status}: ${JSON.stringify(upd.json)}`);

  detail = await api("GET", `/api/tasks/${taskId}`);
  trSub = subRepoOf(detail.json.taskRepos);
  assert(trSub.sub_status !== "skipped", `启用后子仓不应再 skipped，实际 ${trSub.sub_status}`);
  assert(trSub.base_branch === "dev", `子仓签出分支应为 dev，实际 ${trSub.base_branch}`);
  assert(trSub.work_branch === "cc/widgets-x", `子仓工作分支应为 cc/widgets-x，实际 ${trSub.work_branch}`);
  assert(trSub.target_branch === "release", `子仓目标分支应为 release，实际 ${trSub.target_branch}`);
  console.log("✓ 编辑表单启用子仓 + 自定义分支 → task_repos 正确落库");

  // 7) 再次编辑禁用全部子仓（taskRepos=[]）→ 子仓回到 skipped。
  const upd2 = await api("PATCH", `/api/tasks/${taskId}`, { ...updateBody, taskRepos: [] });
  assert(upd2.status === 200, `二次编辑失败 ${upd2.status}: ${JSON.stringify(upd2.json)}`);
  detail = await api("GET", `/api/tasks/${taskId}`);
  trSub = subRepoOf(detail.json.taskRepos);
  assert(trSub.sub_status === "skipped", `禁用后子仓应回 skipped，实际 ${trSub.sub_status}`);
  console.log("✓ 编辑表单取消勾选子仓 → task_repos 回到 skipped");

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
