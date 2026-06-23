// 只读诊断：查任务真实状态 + 最近事件（含 payload），定位 worker 端「仍报相同错误」的 ground truth。
// 用法：node docs/acceptance/failed-task-retry-reply/scripts/diag-task.mjs [taskId]
import pg from "pg";

const taskId = process.argv[2] ?? "2ee00794-3e52-4ecb-88a9-be179eaf3b2a";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const t = await client.query(
    `SELECT id, title, status, claimed_by, claude_session_id,
            work_branch, base_branch, target_branch, submit_mode,
            retry_requested_at, cancel_requested_at, finished_at, updated_at,
            left(error_message, 2000) AS error_message
       FROM tasks WHERE id = $1`,
    [taskId]
  );
  console.log("=== TASK ===");
  console.log(JSON.stringify(t.rows[0] ?? null, null, 2));

  const repos = await client.query(
    `SELECT role, relative_path, work_branch, base_branch, target_branch, sub_status, left(pr_url,120) AS pr_url
       FROM task_repos WHERE task_id = $1 ORDER BY role DESC, relative_path`,
    [taskId]
  );
  console.log("\n=== TASK_REPOS ===");
  console.log(JSON.stringify(repos.rows, null, 2));

  const ev = await client.query(
    `SELECT created_at, worker_id, event_type, left(message, 300) AS message, payload
       FROM task_events WHERE task_id = $1
       ORDER BY created_at DESC LIMIT 40`,
    [taskId]
  );
  console.log("\n=== LAST 40 EVENTS (newest first) ===");
  for (const r of ev.rows.reverse()) {
    const p = r.payload && Object.keys(r.payload).length ? " " + JSON.stringify(r.payload) : "";
    console.log(`${r.created_at.toISOString?.() ?? r.created_at} [${r.event_type}] ${r.message ?? ""}${p}`);
  }
} finally {
  await client.end();
}
