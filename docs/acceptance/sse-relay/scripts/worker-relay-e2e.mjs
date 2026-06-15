// 集成 e2e：真实 WorkerRelay（apps/worker/dist）+ console 同款 createPublisher 对 listening relay 跑一遍。
// 验证：① Worker 订阅能收到 console 发的事件；② Worker 忽略自己发出的事件（origin 过滤防自触发循环）。
// 前置：先 build（relay-client / relay / worker 的 dist 须存在）。运行：node docs/acceptance/sse-relay/scripts/worker-relay-e2e.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 仓库根 = 本脚本目录上溯 4 级（scripts → sse-relay → acceptance → docs → root）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { createRelayServer } = await load("apps/relay/dist/server.js");
const { WorkerRelay } = await load("apps/worker/dist/relay.js");
const { createPublisher } = await load("packages/relay-client/dist/index.js");

const handle = createRelayServer({
  host: "127.0.0.1",
  port: 0,
  secret: "s",
  publishToken: "pub",
  workerToken: "wrk",
  pingIntervalMs: 200,
  ringSize: 50,
  maxBodyBytes: 1_000_000
});
await new Promise((r) => handle.server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${handle.server.address().port}`;

const signals = [];
const relay = new WorkerRelay(
  { workerId: "W1", relayUrl: base, relayPublishToken: "pub", relayWorkerToken: "wrk" },
  (event) => signals.push(event),
  () => {}
);
relay.subscribe(["P1"]); // 订阅 worker:W1 + project:P1
await new Promise((r) => setTimeout(r, 300));

createPublisher({ url: base, token: "pub" }).publish({
  channel: "project:P1",
  type: "task.upserted",
  entityId: "T1",
  projectId: "P1",
  origin: "console",
  payload: { id: "T1" }
});
relay.publish({ channel: "project:P1", type: "worker.upserted", entityId: "W1", projectId: "P1", payload: { id: "W1" } });

await new Promise((r) => setTimeout(r, 500));

assert.ok(signals.some((e) => e.entityId === "T1" && e.origin === "console"), "Worker 应收到 console 发的 project 事件");
assert.ok(!signals.some((e) => e.origin === "W1"), "Worker 必须忽略自己发出的事件（origin 过滤）");
console.log(`relay e2e: PASS ✅（worker 收到 ${signals.length} 条外部信号、忽略了自身事件）`);

relay.stop();
handle.server.close(() => process.exit(0));
setTimeout(() => process.exit(0), 1_000).unref();
