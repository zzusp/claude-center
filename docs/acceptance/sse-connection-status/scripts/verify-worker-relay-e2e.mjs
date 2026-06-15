// 回归(端到端)：worker relay connected → reconnecting。本地 SSE 假服务触发 onOpen(connected)，
// 再销毁连接 + 关服务，使客户端内部退避重连重试到已关端口失败 → onError → reconnecting。
// 先 `npm -w @claude-center/worker run build`，再 `node docs/acceptance/sse-connection-status/scripts/verify-worker-relay-e2e.mjs`。
import http from "node:http";
import { WorkerRelay } from "../../../../apps/worker/dist/relay.js";

const PORT = 59998;
let liveSocket = null;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/events")) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(":ok\n\n");
    liveSocket = res.socket;
  } else {
    res.writeHead(404).end();
  }
});

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exitCode = 1; }
  else { console.log("PASS:", msg); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const relay = new WorkerRelay(
  { relayUrl: `http://127.0.0.1:${PORT}`, relayPublishToken: "pt", relayWorkerToken: "wt", workerId: "wE2E" },
  () => {},
  () => {}
);
relay.subscribe(["pa"]);
assert(relay.state === "connecting", "subscribe → connecting (sync)");

await sleep(400);
assert(relay.state === "connected", "200 SSE 响应 → onOpen → connected");

if (liveSocket) liveSocket.destroy();
await new Promise((r) => server.close(r));

await sleep(2600); // 等内部退避重连(≈1s+jitter)重试失败 → onError
assert(relay.state === "reconnecting", "连接断开 + 重试失败 → onError → reconnecting");

relay.stop();
assert(relay.state === "disabled", "stop → disabled");

console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: ALL PASS");
process.exit(process.exitCode || 0);
