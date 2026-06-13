import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@claude-center/db";

export type WorkerProjectConfig = {
  projectName?: string;
  repoUrl?: string;
  localPath: string;
};

export type WorkerConfig = {
  workerId: string;
  workerName: string;
  hostName: string;
  appVersion: string;
  projects: WorkerProjectConfig[];
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  claudeCommand: string;
  claudePreCommand: string;
  ghCommand: string;
  // 任务执行内核的安全姿态：headless 下自主跑，不为权限停（deny 规则仍硬生效）。
  permissionMode: string;
  // 经 --settings 注入的 deny 护栏（写类 git 交还 Worker），默认指向随应用分发的配置。
  claudeSettingsPath: string;
  // 经 --append-system-prompt-file 注入的中控协议规则，默认指向随应用分发的规则文件。
  claudeRulesPath: string;
  // worker 本地状态/工作树根目录（worker.json、每任务工作树都在其下）。
  dataDir: string;
  // 真并发执行的同时在途任务上限。
  maxParallel: number;
  // 客户端策略：是否允许 web 端远程切换工作态。初值来自 worker.json ?? env，运行时可经 Electron 改。
  allowRemoteControl: boolean;
  // 采集套餐用量时访问 api.anthropic.com 用的代理；null 表示直连。
  usageProxy: string | null;
  // 周期采集 claude 版本/订阅/用量并上报的间隔（ms）。
  infoIntervalMs: number;
};

// worker.json 持久化：workerId（稳定身份）+ allowRemoteControl（客户端策略，跨重启保留）。
type WorkerState = { workerId: string; allowRemoteControl?: boolean };

function dataDirOf(): string {
  return process.env.CLAUDE_CENTER_DATA_DIR ?? path.join(os.homedir(), ".claude-center");
}

function stateFileOf(dataDir: string): string {
  return path.join(dataDir, "worker.json");
}

function readWorkerState(dataDir: string): WorkerState {
  const stateFile = stateFileOf(dataDir);
  let state: WorkerState | null = null;
  if (existsSync(stateFile)) {
    try {
      state = JSON.parse(readFileSync(stateFile, "utf8")) as WorkerState;
    } catch {
      state = null;
    }
  }

  if (state?.workerId) {
    return state;
  }

  mkdirSync(dataDir, { recursive: true });
  const created: WorkerState = { workerId: state?.workerId ?? randomUUID() };
  writeFileSync(stateFile, `${JSON.stringify(created, null, 2)}\n`, "utf8");
  return created;
}

// 持久化 allowRemoteControl（Electron 开关改动后调用），保留 workerId 不变。
export function persistAllowRemoteControl(dataDir: string, workerId: string, allowRemoteControl: boolean): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    stateFileOf(dataDir),
    `${JSON.stringify({ workerId, allowRemoteControl }, null, 2)}\n`,
    "utf8"
  );
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return raw === "1" || raw.toLowerCase() === "true";
}

function readProjectConfig(): WorkerProjectConfig[] {
  const raw = process.env.CLAUDE_CENTER_PROJECTS;
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as WorkerProjectConfig[];
  if (!Array.isArray(parsed)) {
    throw new Error("CLAUDE_CENTER_PROJECTS must be a JSON array");
  }

  for (const project of parsed) {
    if (!project.localPath || (!project.projectName && !project.repoUrl)) {
      throw new Error("Each project link requires localPath and projectName or repoUrl");
    }
  }

  return parsed;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readWorkerConfig(): WorkerConfig {
  // dist/config.js 与 src/config.ts 的 `../prompts`、`../config` 都解析到 apps/worker 下，
  // 故无论以 electron(dist) 还是 tsx(src) 方式运行，资产文件路径都一致。
  const workerDir = path.dirname(fileURLToPath(import.meta.url));
  loadRootEnv(workerDir);
  const dataDir = dataDirOf();
  const state = readWorkerState(dataDir);
  const usageProxy =
    process.env.CLAUDE_CENTER_USAGE_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
  return {
    workerId: process.env.CLAUDE_CENTER_WORKER_ID || state.workerId,
    workerName: process.env.CLAUDE_CENTER_WORKER_NAME || os.hostname(),
    hostName: os.hostname(),
    appVersion: "0.1.0",
    projects: readProjectConfig(),
    pollIntervalMs: readNumber("CLAUDE_CENTER_POLL_INTERVAL_MS", 10_000),
    heartbeatIntervalMs: readNumber("CLAUDE_CENTER_HEARTBEAT_INTERVAL_MS", 15_000),
    claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude",
    claudePreCommand: process.env.CLAUDE_CENTER_CLAUDE_PRE_COMMAND?.trim() || "",
    ghCommand: process.env.GH_COMMAND || "gh",
    permissionMode: process.env.CLAUDE_CENTER_PERMISSION_MODE || "bypassPermissions",
    claudeSettingsPath:
      process.env.CLAUDE_CENTER_CLAUDE_SETTINGS || path.resolve(workerDir, "../config/claude-settings.json"),
    claudeRulesPath:
      process.env.CLAUDE_CENTER_CLAUDE_RULES || path.resolve(workerDir, "../prompts/center-rules.md"),
    dataDir,
    maxParallel: readNumber("CLAUDE_CENTER_MAX_PARALLEL", 1),
    allowRemoteControl: state.allowRemoteControl ?? readBool("CLAUDE_CENTER_ALLOW_REMOTE_CONTROL", false),
    usageProxy,
    infoIntervalMs: readNumber("CLAUDE_CENTER_INFO_INTERVAL_MS", 60_000)
  };
}
