import {
  claimNextDirectCommand,
  claimNextResumableTask,
  claimNextTask,
  getPool,
  heartbeatWorker,
  registerWorker,
  upsertWorkerProjectLink
} from "@claude-center/db";
import { readWorkerConfig, type WorkerConfig } from "./config.js";
import { executeDirectCommand, executeTask, resumeTask } from "./executor.js";

export class ClaudeCenterWorker {
  private readonly config: WorkerConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(config = readWorkerConfig()) {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.register();
    await this.tick();

    this.heartbeatTimer = setInterval(() => {
      heartbeatWorker(getPool(), this.config.workerId).catch((error) => console.error(error));
    }, this.config.heartbeatIntervalMs);

    this.pollTimer = setInterval(() => {
      this.tick().catch((error) => console.error(error));
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

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
      }
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

  private async tick(): Promise<void> {
    if (this.polling) {
      return;
    }

    this.polling = true;
    try {
      await heartbeatWorker(getPool(), this.config.workerId);

      const command = await claimNextDirectCommand(getPool(), this.config.workerId);
      if (command) {
        await executeDirectCommand(this.config, command);
        return;
      }

      // 先续接已收到回复的等待中任务，再领取新任务，让用户回复尽快被处理。
      const resumable = await claimNextResumableTask(getPool(), this.config.workerId);
      if (resumable) {
        await resumeTask(this.config, resumable);
        return;
      }

      const task = await claimNextTask(getPool(), this.config.workerId);
      if (task) {
        await executeTask(this.config, task);
      }
    } finally {
      this.polling = false;
    }
  }
}

if (process.argv[1]?.endsWith("runner.ts") || process.argv[1]?.endsWith("runner.js")) {
  const worker = new ClaudeCenterWorker();
  worker.start().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
