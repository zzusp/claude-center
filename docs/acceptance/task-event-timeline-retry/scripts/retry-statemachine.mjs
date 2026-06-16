// 失败/取消「续接重试」+ 事件补全的 DB 状态机集成测试(真临时库,零污染共享 dev 库)。
// 建临时库 → 跑全量迁移 → 用 @claude-center/db 的导出函数驱动状态机 + 断言 → DROP。
// 覆盖:published/claimed 事件补全、requestTaskRetry/claimNextRetryableTask、机器锁定、
// reactivate 清 retry_requested_at、failed+cancelled 两态、非可重试态守卫。
//
// 用法:node docs/acceptance/task-event-timeline-retry/scripts/retry-statemachine.mjs
// 需要 .env 的 DATABASE_URL(仅用于建/删临时库,绝不碰共享库本身)。
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))));

// 加载最近的 .env(不覆盖已有环境变量),与 ephemeral-db.mjs 一致。
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

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required");

const url = new URL(baseUrl);
const dbName = `claude_center_retrytest_${Date.now()}`;
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(url);
targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
const db = await import("@claude-center/db");

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}`);
  }
}

async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

let created = false;
let pool;
try {
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  console.log(`✓ created ${dbName}`);

  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      await c.query(await readFile(path.join(migrationsDir, file), "utf8"));
      await c.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    }
    await c.query("COMMIT");
  });
  console.log("✓ migrations applied");

  pool = new pg.Pool({ connectionString: targetUrl.toString() });

  // —— 种子:项目 + worker + 关联 —— //
  const project = await db.createProject(pool, {
    name: "retrytest",
    repoUrl: "https://example.com/retrytest.git",
    defaultBranch: "main",
    description: "retry statemachine test"
  });
  const workerId = crypto.randomUUID();
  const otherWorkerId = crypto.randomUUID();
  await db.registerWorker(pool, {
    id: workerId,
    name: "w1",
    hostName: "h1",
    appVersion: "0.0.0",
    capabilities: {},
    metadata: {},
    allowRemoteControl: true,
    maxParallel: 1,
    terminalCommand: "",
    claudePreCommand: ""
  });
  await db.upsertWorkerProjectLink(pool, { workerId, projectName: "retrytest", localPath: "/tmp/retrytest" });

  const newTask = () =>
    db.createTask(pool, {
      projectId: project.id,
      title: "t",
      description: "d",
      baseBranch: "main",
      workBranch: "cc/t",
      targetBranch: "main",
      submitMode: "pr",
      autoMergePr: false,
      autoReply: false,
      autoDecisionHints: "",
      model: "default"
    });
  const row = async (id) => (await pool.query("SELECT status, retry_requested_at, claimed_by FROM tasks WHERE id=$1", [id])).rows[0];
  const eventTypes = async (id) => (await db.listTaskEvents(pool, id)).map((e) => e.event_type);

  // —— 用例 1:全链事件补全 published / claimed —— //
  console.log("\n[1] 事件补全:published / claimed");
  const t1 = await newTask();
  await db.publishTask(pool, t1.id);
  check("publish → status=pending", (await row(t1.id)).status === "pending");
  check("publish 落 'published' 事件", (await eventTypes(t1.id)).includes("published"));
  const claimed = await db.claimNextTask(pool, workerId);
  check("claimNextTask 认领到 t1", claimed?.id === t1.id);
  check("claim → status=claimed", (await row(t1.id)).status === "claimed");
  check("claim 落 'claimed' 事件", (await eventTypes(t1.id)).includes("claimed"));

  // —— 用例 2:失败 → 续接重试 —— //
  console.log("\n[2] 失败续接重试:requestTaskRetry / claimNextRetryableTask / 机器锁定");
  await db.markTaskRunning(pool, t1.id, workerId);
  await db.markTaskFailed(pool, t1.id, workerId, "boom", { failedAt: "x" });
  check("markFailed → status=failed", (await row(t1.id)).status === "failed");
  const retryReq = await db.requestTaskRetry(pool, t1.id);
  check("requestTaskRetry 返回任务", Boolean(retryReq));
  check("retry → retry_requested_at 已置", (await row(t1.id)).retry_requested_at !== null);
  check("retry → 状态仍为 failed(不直接翻 running)", (await row(t1.id)).status === "failed");
  check("retry 落 'retry_requested' 事件", (await eventTypes(t1.id)).includes("retry_requested"));
  const stolen = await db.claimNextRetryableTask(pool, otherWorkerId);
  check("机器锁定:别的 worker 认领不到", stolen === null);
  const retried = await db.claimNextRetryableTask(pool, workerId);
  check("本机 claimNextRetryableTask 认领到 t1", retried?.id === t1.id);
  check("retry 认领 → status=running", (await row(t1.id)).status === "running");
  check("retry 认领 → retry_requested_at 已清", (await row(t1.id)).retry_requested_at === null);

  // —— 用例 3:reactivate 清 retry_requested_at —— //
  console.log("\n[3] reactivate 清空 retry_requested_at");
  await db.markTaskFailed(pool, t1.id, workerId, "boom2", {});
  await db.requestTaskRetry(pool, t1.id);
  check("reactivate 前 retry_requested_at 非空", (await row(t1.id)).retry_requested_at !== null);
  await db.reactivateTask(pool, t1.id);
  const afterReact = await row(t1.id);
  check("reactivate → status=draft", afterReact.status === "draft");
  check("reactivate → retry_requested_at 清空", afterReact.retry_requested_at === null);
  check("reactivate → claimed_by 清空", afterReact.claimed_by === null);

  // —— 用例 4:取消也可续接重试 —— //
  console.log("\n[4] 取消续接重试");
  const t2 = await newTask();
  await db.publishTask(pool, t2.id);
  await db.claimNextTask(pool, workerId);
  await db.markTaskRunning(pool, t2.id, workerId);
  await db.markTaskCancelled(pool, t2.id, workerId, {});
  check("markCancelled → status=cancelled", (await row(t2.id)).status === "cancelled");
  const cancelRetry = await db.requestTaskRetry(pool, t2.id);
  check("cancelled 可 requestTaskRetry", Boolean(cancelRetry));
  const t2retried = await db.claimNextRetryableTask(pool, workerId);
  check("cancelled 续接 → 认领到 t2", t2retried?.id === t2.id);
  check("cancelled 续接 → status=running", (await row(t2.id)).status === "running");

  // —— 用例 5:非可重试态守卫 —— //
  console.log("\n[5] 守卫:非 failed/cancelled 不可重试");
  const t3 = await newTask(); // draft
  check("draft requestTaskRetry → null", (await db.requestTaskRetry(pool, t3.id)) === null);
  // t2 在用例 4 末尾已被 claimNextRetryableTask 翻到 running:running 态也不可重试。
  check("running requestTaskRetry → null", (await db.requestTaskRetry(pool, t2.id)) === null);

  console.log(`\n结果:PASS=${pass} FAIL=${fail}`);
} finally {
  if (pool) await pool.end();
  if (created) {
    await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
    console.log(`✓ dropped ${dbName}`);
  }
}

process.exit(fail === 0 ? 0 : 1);
