// 定时任务 DB 层端到端验证：createTask(scheduled) / promoteDueScheduledTasks / publishTask。
// 直连真库跑，建临时项目做断言，结束 cascade 删除。
// 用法：node docs/acceptance/task-scheduled/scripts/verify-scheduled.mjs
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const {
  getPool,
  closePool,
  createTask,
  publishTask,
  promoteDueScheduledTasks,
  createProject,
  listTaskEvents
} = await import("@claude-center/db");

const pool = getPool();
let ok = true;
const log = (pass, msg) => {
  ok = ok && pass;
  console.log(`${pass ? "PASS" : "FAIL"}  ${msg}`);
};

// 唯一名避免撞已有项目；时间戳进名字（脚本一次性，不复用）。
const stamp = Date.now();
const project = await createProject(pool, {
  name: `__verify_scheduled_${stamp}`,
  repoUrl: `https://example.com/verify-scheduled-${stamp}.git`,
  defaultBranch: "main",
  description: "临时验证项目，脚本结束自动删除"
});

const baseInput = {
  projectId: project.id,
  taskType: "work",
  title: "定时任务验证",
  description: "verify",
  baseBranch: "main",
  workBranch: `cc/verify-${stamp}`,
  targetBranch: "main",
  submitMode: "pr",
  targetFiles: [],
  priority: 0
};

try {
  // 1) 指定将来时间 → 落 scheduled，scheduled_at 写入。
  const future = new Date(Date.now() + 3600_000).toISOString();
  const futureTask = await createTask(pool, { ...baseInput, scheduledAt: future });
  log(futureTask.status === "scheduled", `建将来定时任务 → status=scheduled（实际 ${futureTask.status}）`);
  log(futureTask.scheduled_at != null, "将来定时任务 scheduled_at 已写入");

  // 2) 不指定时间 → 仍走老路径落 draft。
  const draftTask = await createTask(pool, baseInput);
  log(draftTask.status === "draft", `不指定时间 → status=draft（实际 ${draftTask.status}）`);
  log(draftTask.scheduled_at == null, "草稿任务 scheduled_at 为空");

  // 3) 指定过去时间 → scheduled，等待被提升。
  const past = new Date(Date.now() - 60_000).toISOString();
  const pastTask = await createTask(pool, { ...baseInput, scheduledAt: past });
  log(pastTask.status === "scheduled", `建过去定时任务 → status=scheduled（实际 ${pastTask.status}）`);

  // 4) 提升：只翻到点的（past），将来的（future）不动。
  const promoted = await promoteDueScheduledTasks(pool);
  log(promoted >= 1, `promoteDueScheduledTasks 提升条数 ≥1（实际 ${promoted}）`);

  const reread = async (id) => (await pool.query("SELECT status FROM tasks WHERE id=$1", [id])).rows[0]?.status;
  log((await reread(pastTask.id)) === "pending", "过去定时任务到点 → 已转 pending");
  log((await reread(futureTask.id)) === "scheduled", "将来定时任务未到点 → 仍 scheduled");
  log((await reread(draftTask.id)) === "draft", "草稿任务不受调度器影响 → 仍 draft");

  // 5) 提升落审计事件。
  const events = await listTaskEvents(pool, pastTask.id);
  log(
    events.some((e) => e.event_type === "scheduled_published"),
    "提升后写入 scheduled_published 事件"
  );

  // 6) publishTask 对 scheduled 任务即「立即发布」（覆盖定时）。
  const published = await publishTask(pool, futureTask.id);
  log(published?.status === "pending", `对 scheduled 任务 publishTask → pending（实际 ${published?.status}）`);

  // 7) 幂等：无到点任务时再提升返回 0。
  const promotedAgain = await promoteDueScheduledTasks(pool);
  log(promotedAgain === 0, `无到点任务时再提升返回 0（实际 ${promotedAgain}）`);
} finally {
  // cascade 删除项目 → 任务 / 事件一并清掉。
  await pool.query("DELETE FROM projects WHERE id=$1", [project.id]);
  await closePool();
}

console.log(ok ? "\nALL PASS" : "\nHAS FAIL");
process.exit(ok ? 0 : 1);
