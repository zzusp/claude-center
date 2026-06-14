// runner 完整启动路径实跑:能力自检 → registerWorker → 上报,落 dev 库。用临时 dataDir/workerId,跑完清理。
// 用法:从 worktree 根 `npx tsx docs/acceptance/worker-app-enhancements/scripts/verify-runner-boot.mts`
// 依赖已构建的 worker dist + db dist。
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, loadRootEnv } from "@claude-center/db";

loadRootEnv(path.dirname(fileURLToPath(import.meta.url)));

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "wac-runner-"));
const workerId = randomUUID();
process.env.CLAUDE_CENTER_DATA_DIR = tmpDir;
process.env.CLAUDE_CENTER_WORKER_ID = workerId;
process.env.CLAUDE_CENTER_WORKER_NAME = `verify-runner-${workerId.slice(0, 8)}`;
process.env.CLAUDE_CENTER_PROJECTS = ""; // 无项目关联,只验证 boot/注册/能力上报

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = getPool();
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

const { ClaudeCenterWorker } = await import("../../../../apps/worker/dist/runner.js");
const worker = new ClaudeCenterWorker();

try {
  await worker.start();
  await sleep(1500);

  const row = (
    await pool.query<{ name: string; status: string; capabilities: Record<string, { ok?: boolean }> }>(
      "SELECT name, status, capabilities FROM workers WHERE id=$1",
      [workerId]
    )
  ).rows[0];
  check(!!row, "runner.start() 后 worker 已注册到 DB");
  check(row?.status === "online", "注册后 status=online");
  check(!!row?.capabilities?.claude && typeof row.capabilities.claude.ok === "boolean", "上报了真实 claude 能力自检");
  check(!!row?.capabilities?.git && !!row?.capabilities?.gh, "上报了 git/gh 能力自检");

  const snap = await worker.getStatusSnapshot();
  check(Array.isArray(snap.activeTasks) && Array.isArray(snap.logs), "getStatusSnapshot 返回 activeTasks/logs 数组");
  check(snap.capabilities.claude.ok === (row?.capabilities?.claude?.ok ?? false), "快照能力与 DB 上报一致");

  console.log(`\n结果:${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await worker.stop();
  await pool.query("DELETE FROM workers WHERE id=$1", [workerId]);
  await pool.end();
  rmSync(tmpDir, { recursive: true, force: true });
}
