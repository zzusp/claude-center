// 补充验证：dev 库缺 qa / draft 形态，临时创建 → 验证渲染 → pg 直连删除（不留垃圾）。
// 覆盖：draft work（hero-publish 发布区 + 右栏分支信息）、qa（隐藏分支 + 对话区常驻 + 发布区）、scheduled（立即发布）。
// 用法：node docs/acceptance/task-detail-redesign/scripts/verify-detail-states.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3101";
const baseUrl = `http://${host}:${port}`;

const child = spawn(process.execPath, [nextBin, "start", "--hostname", host, "--port", port], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});
let output = "";
const append = (d) => {
  output += d.toString("utf8");
  if (output.length > 20000) output = output.slice(-20000);
};
child.stdout.on("data", append);
child.stderr.on("data", append);
function waitForReady() {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`server not ready\n${output}`)), 40000);
    const iv = setInterval(() => {
      if (output.includes("Ready in") || output.includes("started server")) {
        clearTimeout(to);
        clearInterval(iv);
        resolve();
      }
    }, 250);
    child.on("exit", (c) => {
      clearTimeout(to);
      clearInterval(iv);
      reject(new Error(`server exited ${c}\n${output}`));
    });
  });
}

const MARKERS = ["detail-hero", "lifecycle-bar", "detail-grid", "section-title"];
const createdIds = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

try {
  await waitForReady();

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const cookie = `cc_session=${/cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1]}`;

  const ov = await (await fetch(`${baseUrl}/api/overview`, { headers: { cookie } })).json();
  const projectId = ov.projects?.[0]?.id;
  if (!projectId) throw new Error("no project in dev db");

  const soon = new Date(Date.now() + 3600_000).toISOString();
  async function create(payload) {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(payload)
    });
    if (res.status !== 201) throw new Error(`create failed ${res.status}: ${await res.text()}`);
    const { task } = await res.json();
    createdIds.push(task.id);
    return task;
  }

  const draftWork = await create({
    projectId,
    taskType: "work",
    title: "[verify-redesign] draft work 临时验证",
    description: "临时验证用，脚本结束自动删除。",
    baseBranch: "main"
  });
  const qa = await create({
    projectId,
    taskType: "qa",
    title: "[verify-redesign] qa 临时验证",
    description: "这是一个问答类问题，用于验证 qa 渲染。"
  });
  const scheduled = await create({
    projectId,
    taskType: "work",
    title: "[verify-redesign] scheduled 临时验证",
    description: "临时验证用，定时发布。",
    baseBranch: "main",
    scheduledAt: soon
  });

  async function check(task) {
    const html = await (await fetch(`${baseUrl}/tasks/${task.id}`, { headers: { cookie } })).text();
    return {
      id: task.id,
      type: task.task_type,
      status: task.status,
      hasMarkers: MARKERS.every((m) => html.includes(m)),
      hasPublish: html.includes("hero-publish"),
      hasBranchInfo: html.includes("签出分支"),
      hasChat: html.includes('class="chat"'),
      isQaLabel: html.includes("问答类")
    };
  }

  const r = {
    draftWork: await check(draftWork),
    qa: await check(qa),
    scheduled: await check(scheduled)
  };

  // 断言：
  // draft work → 发布区 + 右栏分支信息 + 非 qa
  // qa        → 发布区 + 隐藏分支 + 对话区 + qa 标签
  // scheduled → 发布区(立即发布)
  const pass =
    r.draftWork.hasMarkers && r.draftWork.hasPublish && r.draftWork.hasBranchInfo && !r.draftWork.isQaLabel &&
    r.qa.hasMarkers && r.qa.hasPublish && !r.qa.hasBranchInfo && r.qa.hasChat && r.qa.isQaLabel &&
    r.scheduled.hasMarkers && r.scheduled.hasPublish;

  console.log(JSON.stringify({ results: r, pass }, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  // 清理：删除本次创建的临时任务（无子记录，直接删 tasks 行）
  if (createdIds.length) {
    const del = await pool.query("DELETE FROM tasks WHERE id = ANY($1::uuid[])", [createdIds]);
    const left = await pool.query("SELECT count(*)::int AS n FROM tasks WHERE id = ANY($1::uuid[])", [createdIds]);
    console.log(`cleanup: deleted ${del.rowCount}, remaining ${left.rows[0].n}`);
  }
  await pool.end();
  child.kill();
}
