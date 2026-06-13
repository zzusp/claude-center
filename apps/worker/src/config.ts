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
};

function readStableWorkerId(): string {
  if (process.env.CLAUDE_CENTER_WORKER_ID) {
    return process.env.CLAUDE_CENTER_WORKER_ID;
  }

  const dataDir = process.env.CLAUDE_CENTER_DATA_DIR ?? path.join(os.homedir(), ".claude-center");
  const stateFile = path.join(dataDir, "worker.json");

  if (existsSync(stateFile)) {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as { workerId?: string };
    if (state.workerId) {
      return state.workerId;
    }
  }

  mkdirSync(dataDir, { recursive: true });
  const workerId = randomUUID();
  writeFileSync(stateFile, `${JSON.stringify({ workerId }, null, 2)}\n`, "utf8");
  return workerId;
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
  loadRootEnv(path.dirname(fileURLToPath(import.meta.url)));
  return {
    workerId: readStableWorkerId(),
    workerName: process.env.CLAUDE_CENTER_WORKER_NAME || os.hostname(),
    hostName: os.hostname(),
    appVersion: "0.1.0",
    projects: readProjectConfig(),
    pollIntervalMs: readNumber("CLAUDE_CENTER_POLL_INTERVAL_MS", 10_000),
    heartbeatIntervalMs: readNumber("CLAUDE_CENTER_HEARTBEAT_INTERVAL_MS", 15_000),
    claudeCommand: process.env.CLAUDE_CODE_COMMAND || "claude",
    claudePreCommand: process.env.CLAUDE_CENTER_CLAUDE_PRE_COMMAND?.trim() || "",
    ghCommand: process.env.GH_COMMAND || "gh"
  };
}
