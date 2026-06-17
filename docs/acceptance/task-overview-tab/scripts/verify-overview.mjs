// 概览 Tab 渲染验证：启动 console（dev/Turbopack）→ admin 登录 → 取一个任务 id →
// 拉 /tasks/<id> 的 SSR HTML，断言五卡结构（基本信息/进度/任务描述/相关信息/执行结果）与
// 加宽 class（detail-tab-content--wide / overview-grid / ov-card--desc）都出现在服务端渲染产物里。
// 用现网共享 dev 库（只读渲染，不写库）。空闲端口由 CONSOLE_PORT 控制（默认 3457）。
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// scripts/verify-overview.mjs → ../../../../ = 仓库根（docs/acceptance/task-overview-tab/scripts/file）。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3457";
const baseUrl = `http://${host}:${port}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const dotNext = path.join(consoleDir, ".next");
if (existsSync(dotNext)) rmSync(dotNext, { recursive: true, force: true });

const child = spawn(process.execPath, [nextBin, "dev", "--turbopack", "--hostname", host, "--port", port], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});

let output = "";
const append = (d) => {
  output += d.toString("utf8");
  if (output.length > 20_000) output = output.slice(-20_000);
};
child.stdout.on("data", append);
child.stderr.on("data", append);

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server not ready\n${output}`)), 120_000);
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
      reject(new Error(`server exited ${code}\n${output}`));
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`);
}

try {
  await waitForReady();

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (!login.ok) throw new Error(`login ${login.status}: ${await login.text()}`);
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  if (!token) throw new Error("no cc_session cookie");
  const cookie = `cc_session=${token}`;

  // 取一个任务 id（dashboard 返回最近任务）。
  const dash = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
  if (!dash.ok) throw new Error(`dashboard ${dash.status}`);
  const { tasks } = await dash.json();
  assert(Array.isArray(tasks) && tasks.length > 0, "dev 库里没有任务可用于渲染验证");
  // 优先挑一个已完成/失败/有 PR 的任务，覆盖更多卡片内容；否则取第一个。
  const target =
    tasks.find((t) => t.status === "success" || t.status === "merged" || t.status === "failed") ?? tasks[0];

  const page = await fetch(`${baseUrl}/tasks/${target.id}`, { headers: { cookie } });
  assert(page.ok, `GET /tasks/${target.id} 返回 ${page.status}`);
  const html = await page.text();

  const checks = {
    "detail-tab-content--wide（加宽）": html.includes("detail-tab-content--wide"),
    "overview-grid（五卡网格）": html.includes("overview-grid"),
    "ov-card--desc（任务描述跨两行）": html.includes("ov-card--desc"),
    "基本信息": html.includes("基本信息"),
    "进度": html.includes("进度"),
    "任务描述": html.includes("任务描述"),
    "相关信息": html.includes("相关信息"),
    "执行结果": html.includes("执行结果"),
    "ov-bar-track（进度条）": html.includes("ov-bar-track")
  };
  for (const [k, v] of Object.entries(checks)) assert(v, `SSR HTML 未包含「${k}」`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        loginStatus: login.status,
        taskId: target.id,
        taskStatus: target.status,
        submitMode: target.submit_mode,
        pageStatus: page.status,
        checks
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
