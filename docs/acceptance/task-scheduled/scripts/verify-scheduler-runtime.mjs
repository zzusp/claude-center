// 调度器运行时验证：证明 apps/console/instrumentation.ts 在真实 Next 服务进程里，
// 周期性地把到点定时任务（scheduled → pending）提升。
// 做法：种一个过去时间的 scheduled 任务 → 用 1.5s 间隔起 console dev 服务 → 轮询任务状态
//       直到变 pending（或超时）→ 断言 → 关服务 + 清理临时项目。
// 用法：node docs/acceptance/task-scheduled/scripts/verify-scheduler-runtime.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const { getPool, closePool, createTask, createProject } = await import("@claude-center/db");
const pool = getPool();

const stamp = Date.now();
const project = await createProject(pool, {
  name: `__verify_sched_rt_${stamp}`,
  repoUrl: `https://example.com/verify-sched-rt-${stamp}.git`,
  defaultBranch: "main",
  description: "临时验证项目，脚本结束自动删除"
});

const task = await createTask(pool, {
  projectId: project.id,
  taskType: "work",
  title: "调度器运行时验证",
  description: "verify",
  baseBranch: "main",
  workBranch: `cc/verify-rt-${stamp}`,
  targetBranch: "main",
  submitMode: "pr",
  targetFiles: [],
  priority: 0,
  scheduledAt: new Date(Date.now() - 60_000).toISOString() // 已过点
});
console.log(`seed: task ${task.id} status=${task.status}`);

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const consoleDir = path.join(root, "apps", "console");
const port = process.env.VERIFY_PORT || "3939";

const child = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", port], {
  cwd: consoleDir,
  env: { ...process.env, CLAUDE_CENTER_SCHEDULER_INTERVAL_MS: "1500" },
  windowsHide: true
});
let out = "";
child.stdout.on("data", (d) => (out += d.toString("utf8")));
child.stderr.on("data", (d) => (out += d.toString("utf8")));

const readStatus = async () =>
  (await pool.query("SELECT status FROM tasks WHERE id=$1", [task.id])).rows[0]?.status;

let promoted = false;
try {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await readStatus();
    if (status === "pending") {
      promoted = true;
      break;
    }
  }
  const finalStatus = await readStatus();
  console.log(`final: task status=${finalStatus}`);
  console.log(promoted ? "PASS  调度器在运行时把到点定时任务提升为 pending" : "FAIL  超时仍未提升");
  if (!promoted) {
    console.log("--- console output tail ---\n" + out.slice(-1500));
  }
} finally {
  child.kill();
  await pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  await closePool();
}

process.exit(promoted ? 0 : 1);
