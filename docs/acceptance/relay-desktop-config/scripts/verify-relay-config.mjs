// 验证「桌面端配置 SSE 中转地址」的非 GUI 核心逻辑（无需 Electron / DB）：
//   1. 无 worker.json 持久化时，relay 配置取自 env；
//   2. persistWorkerState 写入 relay 三项后，再读 config 时持久化值覆盖 env（含清空="禁用"语义）；
//   3. WorkerRelay.reconfigure() 按最新 config 重建发布器 + 复位订阅态（enabled/state 随之变化）。
// 用法：node docs/acceptance/relay-desktop-config/scripts/verify-relay-config.mjs
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(os.tmpdir(), "cc-relay-verify-"));
process.env.CLAUDE_CENTER_DATA_DIR = tmp;
// 显式 env（shell env 优先于 .env），作为「未持久化时」的来源。
process.env.CLAUDE_CENTER_RELAY_URL = "https://env-relay.example.com";
process.env.CLAUDE_CENTER_RELAY_PUBLISH_TOKEN = "env-pub";
process.env.CLAUDE_CENTER_RELAY_WORKER_TOKEN = "env-worker";

const { readWorkerConfig, persistWorkerState } = await import("../../../../apps/worker/dist/config.js");
const { WorkerRelay } = await import("../../../../apps/worker/dist/relay.js");

let failures = 0;
const assert = (label, cond, detail) => {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

// —— 1. 无持久化 → 取自 env ——
console.log("[1] 无 worker.json relay 字段时取 env");
let cfg = readWorkerConfig();
assert("relayUrl 来自 env", cfg.relayUrl === "https://env-relay.example.com", cfg.relayUrl);
assert("relayPublishToken 来自 env", cfg.relayPublishToken === "env-pub", cfg.relayPublishToken);
assert("relayWorkerToken 来自 env", cfg.relayWorkerToken === "env-worker", cfg.relayWorkerToken);

// —— 2. 持久化覆盖 env ——
console.log("[2] persistWorkerState 写入后覆盖 env");
persistWorkerState(tmp, {
  relayUrl: "https://desktop-relay.example.com",
  relayPublishToken: "desk-pub",
  relayWorkerToken: "desk-worker"
});
const onDisk = JSON.parse(readFileSync(path.join(tmp, "worker.json"), "utf8"));
assert("worker.json 落盘含 relayUrl", onDisk.relayUrl === "https://desktop-relay.example.com", JSON.stringify(onDisk));
cfg = readWorkerConfig();
assert("relayUrl 取持久化值", cfg.relayUrl === "https://desktop-relay.example.com", cfg.relayUrl);
assert("relayPublishToken 取持久化值", cfg.relayPublishToken === "desk-pub", cfg.relayPublishToken);
assert("relayWorkerToken 取持久化值", cfg.relayWorkerToken === "desk-worker", cfg.relayWorkerToken);

// —— 2b. 清空保存 = 显式禁用（不回退 env）——
console.log("[2b] 清空保存表示禁用（不回退 env）");
persistWorkerState(tmp, { relayUrl: "", relayPublishToken: "", relayWorkerToken: "" });
cfg = readWorkerConfig();
assert("relayUrl 清空后为空（非回退 env）", cfg.relayUrl === "", cfg.relayUrl);

// —— 3. WorkerRelay 运行时重配 ——
console.log("[3] WorkerRelay.reconfigure() 随最新 config 变化");
// 用一个 enabled 的 config 构造，确认 enabled/state，再就地改 config 并 reconfigure。
const liveCfg = { ...readWorkerConfig(), relayUrl: "https://live.example.com", relayPublishToken: "p", relayWorkerToken: "w", workerId: "wk-test" };
const relay = new WorkerRelay(liveCfg, () => {}, () => {});
assert("有地址时 enabled=true", relay.enabled === true, String(relay.enabled));
assert("未订阅前 state=disabled", relay.state === "disabled", relay.state);
// 模拟桌面端清空地址 → reconfigure（runner 改的是同一 config 引用）。
liveCfg.relayUrl = "";
relay.reconfigure();
assert("清空地址后 enabled=false", relay.enabled === false, String(relay.enabled));
assert("清空地址后 state=disabled", relay.state === "disabled", relay.state);
assert("reconfigure 后频道数归零", relay.channelCount === 0, String(relay.channelCount));
relay.stop();

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
