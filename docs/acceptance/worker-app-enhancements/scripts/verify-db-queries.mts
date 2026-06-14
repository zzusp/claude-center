// 取消流 + 项目关联查询的 dev 库实跑验证。seed 临时 project/worker/task,跑完清理。
// 用法:从 worktree 根 `npx tsx docs/acceptance/worker-app-enhancements/scripts/verify-db-queries.mts`
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProject,
  createTask,
  getPool,
  listCancelRequestedTaskIds,
  listWorkerProjectLinks,
  loadRootEnv,
  markTaskCancelled,
  markTaskFailed,
  registerWorker,
  removeWorkerProjectLink,
  requestTaskCancellation,
  upsertWorkerProjectLink
} from "@claude-center/db";

// 自包含:从脚本位置向上找仓库根 .env 加载 DATABASE_URL。
loadRootEnv(path.dirname(fileURLToPath(import.meta.url)));
const pool = getPool();
const tag = randomUUID().slice(0, 8);
const workerId = randomUUID();
const localPath = `C:\\verify\\${tag}`;
let projectId: string | null = null;
let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    pass += 1;
    console.log(`PASS: ${msg}`);
  } else {
    fail += 1;
    console.error(`FAIL: ${msg}`);
  }
}

try {
  await registerWorker(pool, { id: workerId, name: `verify-${tag}`, hostName: "verify", appVersion: "0.1.0" });
  const project = await createProject(pool, {
    name: `verify-proj-${tag}`,
    repoUrl: `https://example.com/verify-${tag}.git`,
    defaultBranch: "main",
    description: "verify temp"
  });
  projectId = project.id;

  // —— 项目关联 list / remove ——
  await upsertWorkerProjectLink(pool, { workerId, projectName: project.name, localPath });
  let links = await listWorkerProjectLinks(pool, workerId);
  check(
    links.some((l) => l.project_name === project.name && l.local_path === localPath),
    "listWorkerProjectLinks 返回新建关联"
  );
  await removeWorkerProjectLink(pool, { workerId, projectName: project.name, localPath });
  links = await listWorkerProjectLinks(pool, workerId);
  check(!links.some((l) => l.local_path === localPath), "removeWorkerProjectLink 删除该关联");

  // —— 取消流 ——
  const task = await createTask(pool, {
    projectId,
    taskType: "work",
    title: `verify cancel ${tag}`,
    description: "x",
    baseBranch: "main",
    workBranch: `wb-${tag}`,
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    model: "default"
  });
  // 模拟在途:置 running + claimed_by。
  await pool.query("UPDATE tasks SET status='running', claimed_by=$2 WHERE id=$1", [task.id, workerId]);

  const requested = await requestTaskCancellation(pool, task.id);
  check(requested !== null && requested.cancel_requested_at !== null, "requestTaskCancellation 对在途任务打戳并返回");

  const ids = await listCancelRequestedTaskIds(pool, workerId);
  check(ids.includes(task.id), "listCancelRequestedTaskIds 包含被请求取消的任务");

  const cancelled = await markTaskCancelled(pool, task.id, workerId, { reason: "verify" });
  check(cancelled === true, "markTaskCancelled 对在途任务返回 true");
  let status = (await pool.query<{ status: string }>("SELECT status FROM tasks WHERE id=$1", [task.id])).rows[0]?.status;
  check(status === "cancelled", "标记后任务状态为 cancelled");

  // 守卫:markTaskFailed 不能把 cancelled 覆盖回 failed。
  await markTaskFailed(pool, task.id, workerId, "should not apply", {});
  status = (await pool.query<{ status: string }>("SELECT status FROM tasks WHERE id=$1", [task.id])).rows[0]?.status;
  check(status === "cancelled", "markTaskFailed 守卫:不覆盖 cancelled");

  const requestedAgain = await requestTaskCancellation(pool, task.id);
  check(requestedAgain === null, "requestTaskCancellation 对终态任务返回 null");

  const idsAfter = await listCancelRequestedTaskIds(pool, workerId);
  check(!idsAfter.includes(task.id), "listCancelRequestedTaskIds 排除终态任务");

  console.log(`\n结果:${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
} finally {
  if (projectId) {
    await pool.query("DELETE FROM projects WHERE id=$1", [projectId]); // 级联删 tasks/links/events
  }
  await pool.query("DELETE FROM workers WHERE id=$1", [workerId]);
  await pool.end();
}
