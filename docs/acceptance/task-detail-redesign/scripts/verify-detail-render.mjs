// 任务详情页重设计：渲染验证。
// 起 next start（用已构建产物）→ admin 登录 → 取 overview.tasks 多形态代表
// → 逐个 GET /tasks/<id> 断言 HTTP 200 + 新结构(detail-hero/lifecycle-bar/detail-grid/section-title)
//   + 旧 tab 切换已移除(不含 class="tabs") → bogus id 断言 404。
// 用法：node docs/acceptance/task-detail-redesign/scripts/verify-detail-render.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", ".."); // → worktree 根

const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3100";
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
    const timeout = setTimeout(() => reject(new Error(`server not ready\n${output}`)), 40000);
    const interval = setInterval(() => {
      if (output.includes("Ready in") || output.includes("started server")) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 250);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(interval);
      reject(new Error(`server exited ${code}\n${output}`));
    });
  });
}

const MARKERS = ["detail-hero", "lifecycle-bar", "lc-step", "detail-grid", "section-title", "返回任务流"];

try {
  await waitForReady();

  // 登录拿 cookie
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (!login.ok) throw new Error(`login failed ${login.status}: ${await login.text()}`);
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  if (!token) throw new Error("no cc_session cookie");
  const cookie = `cc_session=${token}`;

  // 取任务清单，按 (类型:状态) 去重挑代表，覆盖多形态
  const ov = await fetch(`${baseUrl}/api/overview`, { headers: { cookie } });
  if (!ov.ok) throw new Error(`overview ${ov.status}`);
  const tasks = (await ov.json()).tasks ?? [];
  const picked = new Map();
  for (const t of tasks) {
    const key = `${t.task_type}:${t.status}`;
    if (!picked.has(key)) picked.set(key, t);
  }
  const sample = [...picked.values()].slice(0, 12);

  const results = [];
  for (const t of sample) {
    const res = await fetch(`${baseUrl}/tasks/${t.id}`, { headers: { cookie } });
    const html = await res.text();
    const missing = MARKERS.filter((m) => !html.includes(m));
    results.push({
      id: t.id,
      type: t.task_type,
      status: t.status,
      http: res.status,
      ok: res.status === 200 && missing.length === 0 && !html.includes('class="tabs"'),
      missingMarkers: missing,
      hasOldTabs: html.includes('class="tabs"'),
      hasPublish: html.includes("hero-publish"),
      hasReview: html.includes("review-actions")
    });
  }

  // 越权/不存在 → 404
  const bogus = await fetch(`${baseUrl}/tasks/00000000-0000-0000-0000-000000000000`, { headers: { cookie } });

  const summary = {
    sampledCombos: [...picked.keys()],
    notFoundStatus: bogus.status,
    results,
    allPass: results.length > 0 && results.every((r) => r.ok) && bogus.status === 404
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.allPass) process.exitCode = 1;
} finally {
  child.kill();
}
