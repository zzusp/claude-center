// relay 服务配置，全部来自 CLAUDE_CENTER_RELAY_* 环境变量（见 .env.example / docs/spec/sse-relay-service.md）。

export interface RelayConfig {
  host: string;
  port: number;
  // 浏览器票据 HMAC 密钥（与 Console 共享）。空=拒绝一切票据订阅（仅 worker token 可订阅）。
  secret: string;
  // 发布鉴权 token（Console 服务端 + Worker 共享）。空=拒绝一切发布。
  publishToken: string;
  // Worker 订阅鉴权 token。空=拒绝 worker token 订阅。
  workerToken: string;
  // 保活 :ping 间隔（ms）。
  pingIntervalMs: number;
  // 每频道 ring buffer 容量（Last-Event-ID 短重放用）。
  ringSize: number;
  // /publish 请求体大小上限（字节），防异常大包。
  maxBodyBytes: number;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readRelayConfig(): RelayConfig {
  return {
    host: process.env.CLAUDE_CENTER_RELAY_HOST || "127.0.0.1",
    port: readNumber("CLAUDE_CENTER_RELAY_PORT", 8787),
    secret: process.env.CLAUDE_CENTER_RELAY_SECRET || "",
    publishToken: process.env.CLAUDE_CENTER_RELAY_PUBLISH_TOKEN || "",
    workerToken: process.env.CLAUDE_CENTER_RELAY_WORKER_TOKEN || "",
    pingIntervalMs: readNumber("CLAUDE_CENTER_RELAY_PING_INTERVAL_MS", 15_000),
    ringSize: readNumber("CLAUDE_CENTER_RELAY_RING_SIZE", 200),
    maxBodyBytes: readNumber("CLAUDE_CENTER_RELAY_MAX_BODY_BYTES", 1_000_000)
  };
}

// 自检 / 启动日志用的脱敏视图：不泄露密钥明文，只报「是否已配置」。
export function describeConfig(config: RelayConfig): Record<string, unknown> {
  const mask = (value: string) => (value ? `set(${value.length} chars)` : "MISSING");
  return {
    host: config.host,
    port: config.port,
    secret: mask(config.secret),
    publishToken: mask(config.publishToken),
    workerToken: mask(config.workerToken),
    pingIntervalMs: config.pingIntervalMs,
    ringSize: config.ringSize,
    maxBodyBytes: config.maxBodyBytes
  };
}
