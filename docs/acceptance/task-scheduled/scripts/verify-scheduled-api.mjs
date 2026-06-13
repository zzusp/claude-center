// 定时任务 HTTP 入口验证：POST /api/tasks 的 scheduledAt 校验与落态（覆盖路由层，
// 区别于 verify-scheduled.mjs 直调 DB）。起真服务 + 管理员登录 + 真发请求断言。
// 用法：node docs/acceptance/task-scheduled/scripts/verify-scheduled-api.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const { getPool, closePool, createProject } = await import("@claude-center/db");
const pool = getPool();

const stamp = Date.now();
const project = await createProject(pool, {
  name: `__verify_sched_api_${stamp}`,
  repoUrl: `https://example.com/verify-sched-api-${stamp}.git`,
  defaultBranch: "main",
  description: "临时验证项目，脚本结束自动删除"
});

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const port = process.env.VERIFY_PORT || "3940";
const baseUrl = `http://127.0.0.1:${port}`;

// 长间隔，避免调度器在测试期间提升 future 任务干扰断言。
const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", port], {
  cwd: consoleDir,
  env: { ...process.env, CLAUDE_CENTER_SCHEDULER_INTERVAL_MS: "600000" },
  windowsHide: true
});
let out = "";
child.stdout.on("data", (d) => (out += d.toString("utf8")));
child.stderr.on("data", (d) => (out += d.toString("utf8")));

let ok = true;
const log = (pass, msg) => {
  ok = ok && pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${msg}`);
};

async function waitReady() {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (out.includes("Ready in")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // dev 下路由按需编译：探针轮询 /api/overview 直到返回 401（API 层编译完 + DB 可达），
  // 避免首请求撞到编译中的 500。
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${baseUrl}/api/overview`);
      if (probe.status === 401) return;
    } catch {
      // 服务还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("console 未就绪\n" + out.slice(-1500));
}

const baseTask = {
  projectId: project.id,
  taskType: "work",
  title: "API 定时验证",
  description: "verify",
  baseBranch: "main",
  submitMode: "pr",
  priority: 0,
  dependsOn: []
};

try {
  await waitReady();

  // 登录管理员拿 cookie（依赖 008 引导管理员）。
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  const token = /cc_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  log(Boolean(token), `管理员登录拿到会话 cookie（status ${login.status}）`);
  const cookie = `cc_session=${token}`;
  const post = (payload) =>
    fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify(payload)
    });

  // 1) 过去时间 → 400。
  const pastRes = await post({ ...baseTask, scheduledAt: new Date(Date.now() - 60_000).toISOString() });
  log(pastRes.status === 400, `过去 scheduledAt → 400（实际 ${pastRes.status}）`);

  // 2) 非法时间字符串 → 400。
  const badRes = await post({ ...baseTask, scheduledAt: "not-a-date" });
  log(badRes.status === 400, `非法 scheduledAt → 400（实际 ${badRes.status}）`);

  // 3) 将来时间 → 201 + scheduled + scheduled_at。
  const futureRes = await post({ ...baseTask, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
  const futureBody = await futureRes.json();
  log(futureRes.status === 201, `将来 scheduledAt → 201（实际 ${futureRes.status}）`);
  log(futureBody.task?.status === "scheduled", `将来定时任务 status=scheduled（实际 ${futureBody.task?.status}）`);
  log(futureBody.task?.scheduled_at != null, "将来定时任务 scheduled_at 已写入");

  // 4) 不传 scheduledAt → 201 + draft。
  const draftRes = await post(baseTask);
  const draftBody = await draftRes.json();
  log(draftRes.status === 201, `无 scheduledAt → 201（实际 ${draftRes.status}）`);
  log(draftBody.task?.status === "draft", `无 scheduledAt → status=draft（实际 ${draftBody.task?.status}）`);
} catch (error) {
  log(false, `异常：${error instanceof Error ? error.message : error}`);
} finally {
  if (!ok) {
    console.log("--- console output tail ---\n" + out.slice(-2000));
  }
  child.kill();
  await pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  await closePool();
}

console.log(ok ? "\nALL PASS" : "\nHAS FAIL");
process.exit(ok ? 0 : 1);
