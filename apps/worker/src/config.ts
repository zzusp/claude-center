import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadRootEnv, setDatabaseUrl } from "@claude-center/db";

export type WorkerProjectConfig = {
  projectName?: string;
  repoUrl?: string;
  localPath: string;
  // 来源:env = 来自 CLAUDE_CENTER_PROJECTS（桌面端只读）;local = 桌面端添加并持久化进 worker.json（可删）。
  source?: "env" | "local";
};

export type WorkerConfig = {
  workerId: string;
  workerName: string;
  hostName: string;
  appVersion: string;
  // 与 Console 协同的 PostgreSQL 连接串。桌面端持久化优先（设过即覆盖 env），其次 env，最后空。
  // 空 = 未配置：窗口照常出，但注册/轮询会因缺库失败，需在「设置 → 数据库连接」里填。
  databaseUrl: string;
  projects: WorkerProjectConfig[];
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  claudeCommand: string;
  // 运行 claude 前在同一终端会话先执行的命令（VPN/代理/账号登录等），按运行终端语法书写；空=不执行。
  claudePreCommand: string;
  // 运行 claude 的终端可执行文件全路径；空=默认（Windows: powershell / 其余: 直接 spawn claude）。
  terminalCommand: string;
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
  // 套餐用量（远程 oauth/usage）单独的采集间隔（ms），独立于 infoIntervalMs 的高频刷新。
  // 用量窗口是 5h/7d 缓变量，无需 60s 高频；放慢可避开该接口限流（rate_limit_error）。
  usageIntervalMs: number;
  // SSE 中转服务基址（CLAUDE_CENTER_RELAY_URL）。空=禁用中转、纯走数据库轮询。
  relayUrl: string;
  // 向中转发布事件的鉴权 token（CLAUDE_CENTER_RELAY_PUBLISH_TOKEN）。
  relayPublishToken: string;
  // 订阅中转的 worker 鉴权 token（CLAUDE_CENTER_RELAY_WORKER_TOKEN）。
  relayWorkerToken: string;
};

// worker.json 持久化:workerId（稳定身份）+ 跨重启保留的客户端策略（allowRemoteControl/maxParallel）
// + 桌面端添加的本地项目关联（projects，source=local）。env 来源的项目不入此文件。
export type WorkerState = {
  workerId: string;
  allowRemoteControl?: boolean;
  maxParallel?: number;
  projects?: WorkerProjectConfig[];
  // 桌面端配置的数据库连接串，跨重启保留；设了即覆盖同名 env。
  databaseUrl?: string;
  // 桌面端配置的运行终端与前置命令，跨重启保留。
  terminalCommand?: string;
  claudePreCommand?: string;
  // 桌面端配置的 SSE 中转服务地址与鉴权 token，跨重启保留；设了即覆盖同名 env。
  relayUrl?: string;
  relayPublishToken?: string;
  relayWorkerToken?: string;
};

function dataDirOf(): string {
  return process.env.CLAUDE_CENTER_DATA_DIR ?? path.join(os.homedir(), ".claude-center");
}

function stateFileOf(dataDir: string): string {
  return path.join(dataDir, "worker.json");
}

export function readWorkerState(dataDir: string): WorkerState {
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

// 读改写 worker.json:合并 patch（保留 workerId 不变）。桌面端改并发数/远程开关/增删本地项目时调用。
export function persistWorkerState(dataDir: string, patch: Partial<Omit<WorkerState, "workerId">>): WorkerState {
  mkdirSync(dataDir, { recursive: true });
  const current = readWorkerState(dataDir);
  const next: WorkerState = { ...current, ...patch };
  writeFileSync(stateFileOf(dataDir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
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

  return parsed.map((project) => ({ ...project, source: "env" as const }));
}

// 项目关联去重键:同一项目（按 projectName||repoUrl）+ 同一本地路径视为同一关联。
export function projectLinkKey(project: WorkerProjectConfig): string {
  return `${project.projectName ?? project.repoUrl ?? ""}|${project.localPath}`;
}

// 合并 env 项目与 worker.json 持久化的本地项目;env 优先（冲突时保留 env、标记不可删）。
function mergeProjects(envProjects: WorkerProjectConfig[], localProjects: WorkerProjectConfig[]): WorkerProjectConfig[] {
  const merged = new Map<string, WorkerProjectConfig>();
  for (const project of envProjects) {
    merged.set(projectLinkKey(project), { ...project, source: "env" });
  }
  for (const project of localProjects) {
    const key = projectLinkKey(project);
    if (!merged.has(key)) {
      merged.set(key, { ...project, source: "local" });
    } else {
      // env 优先：同 key 的本地关联被环境变量同名项覆盖。曾静默跳过让用户困惑「我加的关联怎么没了」，
      // 这里显式告警（env 配置不可在桌面端删除，故被覆盖的本地项无法生效）。
      console.warn(
        `[config] 本地关联「${project.projectName ?? project.repoUrl ?? key}」与 CLAUDE_CENTER_PROJECTS 同名，已被 env 配置覆盖（env 优先、不可在桌面端删除）`
      );
    }
  }
  return [...merged.values()];
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
  // 桌面端持久化优先（设过即覆盖 env），其次 env，最后空。注入 db 包让所有 getPool() 用此串（worker.json 覆盖 env）。
  const databaseUrl = state.databaseUrl ?? (process.env.DATABASE_URL?.trim() || "");
  setDatabaseUrl(databaseUrl || null);
  return {
    workerId: process.env.CLAUDE_CENTER_WORKER_ID || state.workerId,
    workerName: process.env.CLAUDE_CENTER_WORKER_NAME || os.hostname(),
    hostName: os.hostname(),
    appVersion: "0.1.0",
    databaseUrl,
    projects: mergeProjects(readProjectConfig(), state.projects ?? []),
    pollIntervalMs: readNumber("CLAUDE_CENTER_POLL_INTERVAL_MS", 10_000),
    heartbeatIntervalMs: readNumber("CLAUDE_CENTER_HEARTBEAT_INTERVAL_MS", 15_000),
    claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude",
    // 桌面端持久化优先，其次 env，最后空。
    claudePreCommand: state.claudePreCommand ?? (process.env.CLAUDE_CENTER_CLAUDE_PRE_COMMAND?.trim() || ""),
    terminalCommand: state.terminalCommand ?? (process.env.CLAUDE_CENTER_TERMINAL?.trim() || ""),
    ghCommand: process.env.GH_COMMAND || "gh",
    permissionMode: process.env.CLAUDE_CENTER_PERMISSION_MODE || "bypassPermissions",
    claudeSettingsPath:
      process.env.CLAUDE_CENTER_CLAUDE_SETTINGS || path.resolve(workerDir, "../config/claude-settings.json"),
    claudeRulesPath:
      process.env.CLAUDE_CENTER_CLAUDE_RULES || path.resolve(workerDir, "../prompts/center-rules.md"),
    dataDir,
    maxParallel: state.maxParallel ?? readNumber("CLAUDE_CENTER_MAX_PARALLEL", 1),
    allowRemoteControl: state.allowRemoteControl ?? readBool("CLAUDE_CENTER_ALLOW_REMOTE_CONTROL", false),
    usageProxy,
    infoIntervalMs: readNumber("CLAUDE_CENTER_INFO_INTERVAL_MS", 60_000),
    usageIntervalMs: readNumber("CLAUDE_CENTER_USAGE_INTERVAL_MS", 300_000),
    // 桌面端持久化优先（设过即覆盖 env），其次 env，最后空。与 terminalCommand/claudePreCommand 同模式。
    relayUrl: state.relayUrl ?? (process.env.CLAUDE_CENTER_RELAY_URL?.trim() || ""),
    relayPublishToken: state.relayPublishToken ?? (process.env.CLAUDE_CENTER_RELAY_PUBLISH_TOKEN?.trim() || ""),
    relayWorkerToken: state.relayWorkerToken ?? (process.env.CLAUDE_CENTER_RELAY_WORKER_TOKEN?.trim() || "")
  };
}
