import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
    }, 30_000);

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
  const unauth = await fetch(`${baseUrl}/api/overview`);
  if (unauth.status !== 401) {
    throw new Error(`未登录的 GET /api/overview 应为 401，实际 ${unauth.status}: ${await unauth.text()}`);
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

  // 3) 带 cookie 访问受保护 API 应为 200，并返回各项计数。
  const overview = await fetch(`${baseUrl}/api/overview`, { headers: { cookie } });
  if (!overview.ok) {
    throw new Error(`已登录的 GET /api/overview 返回 ${overview.status}: ${await overview.text()}`);
  }
  const payload = await overview.json();

  // 4b) 健康块应随 overview 返回：DB 连接池 + 定时调度器状态。
  if (!payload.health || !payload.health.db || !payload.health.scheduler) {
    throw new Error(`overview 缺少 health 块：${JSON.stringify(payload.health)}`);
  }
  if (payload.health.db.ok !== true || typeof payload.health.db.latencyMs !== "number") {
    throw new Error(`health.db 异常：${JSON.stringify(payload.health.db)}`);
  }

  // 4) 带 cookie 访问首页（中控台）应为 200。
  const page = await fetch(baseUrl, { headers: { cookie } });
  if (!page.ok) {
    throw new Error(`已登录的 GET / 返回 ${page.status}`);
  }

  console.log(
    JSON.stringify(
      {
        unauthOverviewStatus: unauth.status,
        loginStatus: login.status,
        pageStatus: page.status,
        projects: payload.projects.length,
        workers: payload.workers.length,
        tasks: payload.tasks.length,
        commands: payload.commands.length,
        health: payload.health
      },
      null,
      2
    )
  );
} finally {
  child.kill();
}
