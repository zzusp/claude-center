import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const host = process.env.CONSOLE_HOST || "127.0.0.1";
const port = process.env.CONSOLE_PORT || "3000";
const baseUrl = `http://${host}:${port}`;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// 清 .next：next build 与 dev server 同写 .next 会假报错，验证前清一次保证 hermetic（尤其 worktree 内）。
const dotNext = path.join(consoleDir, ".next");
if (existsSync(dotNext)) {
  rmSync(dotNext, { recursive: true, force: true });
}

const child = spawn(process.execPath, [nextBin, "dev", "--hostname", host, "--port", port], {
  cwd: consoleDir,
  env: process.env,
  windowsHide: true
});

let output = "";

function append(data) {
  output += data.toString("utf8");
  if (output.length > 20_000) {
    output = output.slice(-20_000);
  }
}

child.stdout.on("data", append);
child.stderr.on("data", append);

function waitForReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Console dev server did not become ready.\n${output}`));
    }, 120_000);

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
      reject(new Error(`Console dev server exited with ${code}.\n${output}`));
    });
  });
}

try {
  await waitForReady();

  // 1) 未登录访问受保护 API 必须 401。
  const unauth = await fetch(`${baseUrl}/api/dashboard`);
  if (unauth.status !== 401) {
    throw new Error(`未登录的 GET /api/dashboard 应为 401，实际 ${unauth.status}: ${await unauth.text()}`);
  }

  // 2) 用引导管理员登录，拿会话 cookie（需先跑过 db:migrate 应用 008）。
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  if (!login.ok) {
    throw new Error(`POST /api/auth/login 失败 ${login.status}: ${await login.text()}`);
  }
  const setCookie = login.headers.get("set-cookie") ?? "";
  const token = /cc_session=([^;]+)/.exec(setCookie)?.[1];
  if (!token) {
    throw new Error(`登录响应未带 cc_session cookie：${setCookie}`);
  }
  const cookie = `cc_session=${token}`;

  // 3) 带 cookie 访问总览数据端点应为 200（拆分后取代旧 /api/overview）。
  const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
  if (!dashboard.ok) {
    throw new Error(`已登录的 GET /api/dashboard 返回 ${dashboard.status}: ${await dashboard.text()}`);
  }
  const payload = await dashboard.json();

  // 4b) 健康块应随 dashboard 返回：DB 连接池 + 定时调度器状态。
  if (!payload.health || !payload.health.db || !payload.health.scheduler) {
    throw new Error(`dashboard 缺少 health 块：${JSON.stringify(payload.health)}`);
  }
  if (payload.health.db.ok !== true || typeof payload.health.db.latencyMs !== "number") {
    throw new Error(`health.db 异常：${JSON.stringify(payload.health.db)}`);
  }

  // 4c) 侧边栏计数端点（拆分后由 Shell 轮询保持徽标新鲜）：已登录应为 200 且含 counts。
  const summary = await fetch(`${baseUrl}/api/summary`, { headers: { cookie } });
  if (!summary.ok) {
    throw new Error(`已登录的 GET /api/summary 返回 ${summary.status}: ${await summary.text()}`);
  }
  const summaryPayload = await summary.json();
  if (!summaryPayload.counts || typeof summaryPayload.counts.tasks !== "number") {
    throw new Error(`summary 缺少 counts：${JSON.stringify(summaryPayload)}`);
  }

  // 4) 带 cookie 访问首页（中控台）应为 200。
  const page = await fetch(baseUrl, { headers: { cookie } });
  if (!page.ok) {
    throw new Error(`已登录的 GET / 返回 ${page.status}`);
  }

  console.log(
    JSON.stringify(
      {
        unauthDashboardStatus: unauth.status,
        loginStatus: login.status,
        pageStatus: page.status,
        workers: payload.workers.length,
        tasks: payload.tasks.length,
        counts: summaryPayload.counts,
        health: payload.health
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
