import { describeConfig, readRelayConfig } from "./config.js";
import { loadRelayEnv } from "./env.js";
import { createRelayServer } from "./server.js";

loadRelayEnv();
const config = readRelayConfig();

// --check：零副作用自检——只打印脱敏配置计划并退出，不监听端口、不连任何外部资源。
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ check: true, config: describeConfig(config) }, null, 2));
  const missing: string[] = [];
  if (!config.secret) missing.push("CLAUDE_CENTER_RELAY_SECRET");
  if (!config.publishToken) missing.push("CLAUDE_CENTER_RELAY_PUBLISH_TOKEN");
  if (!config.workerToken) missing.push("CLAUDE_CENTER_RELAY_WORKER_TOKEN");
  if (missing.length) {
    console.warn(`[relay] 警告：以下密钥未配置，相关订阅/发布会被拒绝：${missing.join(", ")}`);
  }
  process.exit(0);
}

const { server } = createRelayServer(config);
server.listen(config.port, config.host, () => {
  console.log(`[relay] listening on http://${config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[relay] ${signal} received, closing`);
  server.close(() => process.exit(0));
  // 兜底：5s 内未优雅关停则强退（SSE 长连接会拖住 close）。
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
