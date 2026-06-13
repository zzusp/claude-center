import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { runCommand } from "./shell.js";

// 采集 worker 机器上 Claude Code 的安装/账号信息，上报给中控展示。
// 数据源在 docs/spec/worker-detail-usage-parallel.md 有实测记录，全部容错：拿不到不崩 worker。

export type UsageWindow = { utilization: number; resets_at: string };
export type WorkerUsage = {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
  fetched_at?: string;
};

export type ClaudeInspect = {
  claudeVersion: string | null;
  subscriptionType: string;
  usage: WorkerUsage;
};

// `claude --version` → "2.1.177 (Claude Code)"，取前导语义版本号。
export async function getClaudeVersion(config: WorkerConfig): Promise<string | null> {
  try {
    const result = await runCommand(config.claudeCommand, ["--version"], { timeoutMs: 15_000 });
    const match = result.stdout.match(/(\d+\.\d+\.\d+(?:[-.\w]*)?)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// Claude Code 配置目录：CLAUDE_CONFIG_DIR 覆盖，否则 ~/.claude。凭据在其下 .credentials.json。
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

type Subscription = { subscriptionType: string; accessToken: string | null };

// 判定订阅类型：凭据文件有 claudeAiOauth → 套餐（取 subscriptionType，如 max/pro）；
// 否则有 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN → api（按量计费）；都没有 → unknown。
function readSubscription(): Subscription {
  try {
    const raw = readFileSync(path.join(claudeConfigDir(), ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { subscriptionType?: string; accessToken?: string };
    };
    const oauth = parsed.claudeAiOauth;
    if (oauth?.accessToken) {
      return {
        subscriptionType: oauth.subscriptionType || "unknown",
        accessToken: oauth.accessToken
      };
    }
  } catch {
    // 文件不存在 / 不可读 / 非 JSON：回退到 env 判定。
  }

  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return { subscriptionType: "api", accessToken: null };
  }
  return { subscriptionType: "unknown", accessToken: null };
}

function parseWindow(value: unknown): UsageWindow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const win = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof win.utilization === "number" && typeof win.resets_at === "string") {
    return { utilization: win.utilization, resets_at: win.resets_at };
  }
  return undefined;
}

// 套餐用量：undocumented oauth/usage 接口。用 curl（跨平台、可靠认 -x 代理）；
// shell:false 防 Windows 把含空格的 Authorization 头重解析。失败/非套餐 → 空对象。
async function fetchUsage(accessToken: string, proxy: string | null): Promise<WorkerUsage> {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const args = [
    "-sS",
    "--max-time",
    "20",
    "-H",
    `Authorization: Bearer ${accessToken}`,
    "-H",
    "anthropic-beta: oauth-2025-04-20",
    ...(proxy ? ["-x", proxy] : []),
    "https://api.anthropic.com/api/oauth/usage"
  ];

  try {
    const result = await runCommand(curl, args, { timeoutMs: 25_000, shell: false });
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const usage: WorkerUsage = { fetched_at: new Date().toISOString() };
    const fiveHour = parseWindow(parsed.five_hour);
    const sevenDay = parseWindow(parsed.seven_day);
    if (fiveHour) usage.five_hour = fiveHour;
    if (sevenDay) usage.seven_day = sevenDay;
    return usage;
  } catch {
    return {};
  }
}

// 一次性采集全部：版本 + 订阅 + （仅套餐账号才查）用量。
export async function inspectClaude(config: WorkerConfig): Promise<ClaudeInspect> {
  const [claudeVersion, subscription] = await Promise.all([
    getClaudeVersion(config),
    Promise.resolve(readSubscription())
  ]);

  const usage = subscription.accessToken
    ? await fetchUsage(subscription.accessToken, config.usageProxy)
    : {};

  return { claudeVersion, subscriptionType: subscription.subscriptionType, usage };
}
