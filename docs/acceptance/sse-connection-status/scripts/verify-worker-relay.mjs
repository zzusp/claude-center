// 回归：worker relay 状态机确定性部分（disabled / connecting(同步) / channelCount / stop→disabled）。
// connected / reconnecting 见 verify-worker-relay-e2e.mjs。
// 先 `npm -w @claude-center/worker run build`，再 `node docs/acceptance/sse-connection-status/scripts/verify-worker-relay.mjs`。
import { WorkerRelay } from "../../../../apps/worker/dist/relay.js";

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else { console.log("PASS:", msg); }
}
const noop = () => {};

const off = new WorkerRelay({ relayUrl: "", relayPublishToken: "", relayWorkerToken: "", workerId: "w1" }, noop, noop);
assert(off.enabled === false, "no relayUrl → enabled=false");
assert(off.state === "disabled", "no relayUrl → state=disabled");
assert(off.channelCount === 0, "no relayUrl → channelCount=0");
off.subscribe(["p1", "p2"]);
assert(off.state === "disabled", "subscribe no-op when disabled → state stays disabled");
assert(off.channelCount === 0, "subscribe no-op when disabled → channelCount stays 0");

const on = new WorkerRelay({ relayUrl: "http://127.0.0.1:59999", relayPublishToken: "pt", relayWorkerToken: "wt", workerId: "w2" }, noop, noop);
assert(on.enabled === true, "relayUrl set → enabled=true");
assert(on.state === "disabled", "before subscribe → state=disabled (initial)");
on.subscribe(["pa", "pb"]);
assert(on.state === "connecting", "after subscribe → state=connecting (synchronous, before async error)");
assert(on.channelCount === 3, "channelCount = worker(1) + projects(2) = 3");
on.stop();
assert(on.state === "disabled", "after stop → state=disabled");

console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: ALL PASS");
process.exit(process.exitCode || 0);
