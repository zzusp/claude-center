import {
  claimNextCleanupCandidate,
  claimNextDirectCommand,
  claimNextRejectedTask,
  claimNextResumableTask,
  claimNextTask,
  getPool,
  getWorkerRuntime,
  heartbeatWorker,
  listActiveTaskIdsForWorker,
  registerWorker,
  setWorkerWorkingState,
  updateWorkerInfo,
  upsertWorkerProjectLink
} from "@claude-center/db";
import { persistAllowRemoteControl, readWorkerConfig, type WorkerConfig } from "./config.js";
import { cleanupMergedTask, executeDirectCommand, executeTask, rerunRejectedTask, resumeTask } from "./executor.js";
import { inspectClaude, type ClaudeInspect } from "./inspect.js";
import { gcWorktrees } from "./worktree.js";

// 暴露给桌面端（Electron）展示与开关用的状态快照。
export type WorkerStatusSnapshot = {
  workerName: string;
  workingState: "idle" | "working";
  allowRemoteControl: boolean;
  maxParallel: number;
  activeCount: number;
  claudeVersion: string | null;
  subscriptionType: string;
};

export class ClaudeCenterWorker {
  private readonly config: WorkerConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private infoTimer: NodeJS.Timeout | null = null;
  // 仅护住「认领循环」，不护执行：执行 fire-and-forget 进 active 跟踪，实现真并发。
  private claiming = false;
  private readonly active = new Map<string, Promise<void>>();
  private lastInspect: ClaudeInspect = { claudeVersion: null, subscriptionType: "unknown", usage: {} };

  constructor(config = readWorkerConfig()) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.register();
    await this.gcOrphanWorktrees();
    await this.refreshInfo();
    await this.tick();

    this.heartbeatTimer = setInterval(() => {
      heartbeatWorker(getPool(), this.config.workerId).catch((error) => console.error(error));
    }, this.config.heartbeatIntervalMs);

    this.infoTimer = setInterval(() => {
      this.refreshInfo().catch((error) => console.error(error));
    }, this.config.infoIntervalMs);

    this.pollTimer = setInterval(() => {
      this.tick().catch((error) => console.error(error));
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.infoTimer) clearInterval(this.infoTimer);
  }

  // —— 桌面端开关 —— //

  // 本地切换工作态（viaRemote 默认 false，不受 allow_remote_control 约束）。切到 working 立即催一次认领。
  async setWorkingState(state: "idle" | "working"): Promise<void> {
    await setWorkerWorkingState(getPool(), this.config.workerId, state);
    if (state === "working") {
      void this.tick();
    }
  }

  // 客户端策略开关：是否允许 web 远程控制。改内存 + 持久化 worker.json + 立即上报 DB。
  async setAllowRemoteControl(allow: boolean): Promise<void> {
    this.config.allowRemoteControl = allow;
    persistAllowRemoteControl(this.config.dataDir, this.config.workerId, allow);
    await this.refreshInfo();
  }

  async getStatusSnapshot(): Promise<WorkerStatusSnapshot> {
    const runtime = await getWorkerRuntime(getPool(), this.config.workerId);
    return {
      workerName: this.config.workerName,
      workingState: runtime?.working_state ?? "idle",
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: runtime?.max_parallel ?? this.config.maxParallel,
      activeCount: this.active.size,
      claudeVersion: this.lastInspect.claudeVersion,
      subscriptionType: this.lastInspect.subscriptionType
    };
  }

  // —— 内部 —— //

  private async register(): Promise<void> {
    const pool = getPool();
    await registerWorker(pool, {
      id: this.config.workerId,
      name: this.config.workerName,
      hostName: this.config.hostName,
      appVersion: this.config.appVersion,
      capabilities: {
        git: true,
        claudeCode: true,
        githubCli: true
      },
      metadata: {
        projectCount: this.config.projects.length
      },
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: this.config.maxParallel
    });

    for (const project of this.config.projects) {
      await upsertWorkerProjectLink(pool, {
        workerId: this.config.workerId,
        projectName: project.projectName,
        repoUrl: project.repoUrl,
        localPath: project.localPath
      });
    }
  }

  // 启动时清理残留工作树：任务已进终态（不在 active 集）的工作树删掉，避免 worktrees 目录无限增长。
  private async gcOrphanWorktrees(): Promise<void> {
    try {
      const activeIds = await listActiveTaskIdsForWorker(getPool(), this.config.workerId);
      const keep = new Set(activeIds);
      for (const project of this.config.projects) {
        await gcWorktrees(this.config, project.localPath, keep);
      }
    } catch (error) {
      console.error(error);
    }
  }

  // 采集 claude 版本/订阅/用量 + 当前客户端策略，写入 DB 供 Console 展示。
  private async refreshInfo(): Promise<void> {
    this.lastInspect = await inspectClaude(this.config);
    await updateWorkerInfo(getPool(), this.config.workerId, {
      claudeVersion: this.lastInspect.claudeVersion,
      subscriptionType: this.lastInspect.subscriptionType,
      usage: this.lastInspect.usage,
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: this.config.maxParallel
    });
  }

  private async tick(): Promise<void> {
    if (this.claiming) {
      return;
    }
    this.claiming = true;
    try {
      const runtime = await getWorkerRuntime(getPool(), this.config.workerId);
      // 工作态门控：在线 ≠ 接任务。idle 时不认领新工作（在途任务继续跑完）。
      if (!runtime || runtime.working_state !== "working") {
        return;
      }
      // 真并发：在并行上限内反复认领并 fire-and-forget 启动，认不到即停。
      while (this.active.size < runtime.max_parallel) {
        const started = await this.claimAndStartOne();
        if (!started) {
          break;
        }
      }
    } finally {
      this.claiming = false;
    }
  }

  // 按优先级认领一个工作单元并启动执行；认领成功返回 true。
  private async claimAndStartOne(): Promise<boolean> {
    const pool = getPool();

    const command = await claimNextDirectCommand(pool, this.config.workerId);
    if (command) {
      this.track(`cmd:${command.id}`, executeDirectCommand(this.config, command));
      return true;
    }

    // 先续接已收到回复的等待中任务，再处理打回重跑，最后才领全新任务。
    const resumable = await claimNextResumableTask(pool, this.config.workerId);
    if (resumable) {
      this.track(`task:${resumable.id}`, resumeTask(this.config, resumable));
      return true;
    }

    const rejected = await claimNextRejectedTask(pool, this.config.workerId);
    if (rejected) {
      this.track(`task:${rejected.id}`, rerunRejectedTask(this.config, rejected));
      return true;
    }

    const task = await claimNextTask(pool, this.config.workerId);
    if (task) {
      this.track(`task:${task.id}`, executeTask(this.config, task));
      return true;
    }

    // 最低优先级：轮转检查一个已建 PR 的 success 任务是否已合并，合并则清理工作树/分支并转 merged。
    const cleanup = await claimNextCleanupCandidate(pool, this.config.workerId);
    if (cleanup) {
      this.track(`cleanup:${cleanup.id}`, cleanupMergedTask(this.config, cleanup));
      return true;
    }

    return false;
  }

  // fire-and-forget 跟踪一个在途执行；完成后从 active 移除并催一次 tick（腾出的并行槽立刻再认领）。
  private track(key: string, promise: Promise<void>): void {
    const tracked = promise
      .catch((error) => console.error(error))
      .finally(() => {
        this.active.delete(key);
        void this.tick();
      });
    this.active.set(key, tracked);
  }
}

if (process.argv[1]?.endsWith("runner.ts") || process.argv[1]?.endsWith("runner.js")) {
  const worker = new ClaudeCenterWorker();
  worker.start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
