import { randomUUID } from "node:crypto";
import {
  closePool,
  getPool,
  getWorkerRuntime,
  listWorkers,
  loadRootEnv,
  registerWorker,
  setWorkerWorkingState,
  updateWorkerInfo
} from "@claude-center/db";

loadRootEnv(process.cwd());
const pool = getPool();
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const id = randomUUID();

  const w = await registerWorker(client, {
    id,
    name: "verify-wt",
    hostName: "verify-host",
    appVersion: "0.1.0",
    allowRemoteControl: true,
    maxParallel: 3
  });
  console.log("[register] working_state(默认应 idle):", w.working_state, "| allow:", w.allow_remote_control, "| max:", w.max_parallel, "| sub:", w.subscription_type, "| claude_version:", w.claude_version);

  await updateWorkerInfo(client, id, {
    claudeVersion: "2.1.177",
    subscriptionType: "max",
    usage: { five_hour: { utilization: 13, resets_at: "2026-06-13T21:19:59+00:00" } },
    allowRemoteControl: true,
    maxParallel: 3
  });
  const afterInfo = (await listWorkers(client)).find((x) => x.id === id);
  console.log("[updateInfo] claude_version:", afterInfo?.claude_version, "| sub:", afterInfo?.subscription_type, "| usage:", JSON.stringify(afterInfo?.usage), "| active_task_count:", afterInfo?.active_task_count);

  const r1 = await setWorkerWorkingState(client, id, "working", { viaRemote: true });
  const rt1 = await getWorkerRuntime(client, id);
  console.log("[remote set working, allow=true] updated应true:", r1, "| runtime:", JSON.stringify(rt1));

  // 关闭远程开关后，远程切换应被拒（0 行）。
  await updateWorkerInfo(client, id, {
    claudeVersion: "2.1.177",
    subscriptionType: "max",
    usage: {},
    allowRemoteControl: false,
    maxParallel: 3
  });
  const r2 = await setWorkerWorkingState(client, id, "idle", { viaRemote: true });
  const rt2 = await getWorkerRuntime(client, id);
  console.log("[remote set, allow=false] updated应false:", r2, "| runtime仍working:", JSON.stringify(rt2));

  // 本地切换不受 allow 约束。
  const r3 = await setWorkerWorkingState(client, id, "idle", {});
  const rt3 = await getWorkerRuntime(client, id);
  console.log("[local set idle] updated应true:", r3, "| runtime:", JSON.stringify(rt3));

  await client.query("ROLLBACK");
  console.log("[done] ROLLBACK，未污染共享库");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("[FAIL]", error);
  process.exitCode = 1;
} finally {
  client.release();
  await closePool(pool);
}
