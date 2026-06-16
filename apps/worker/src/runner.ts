import type { ChildProcess } from "node:child_process";
import {
  acceptTask,
  addTaskComment,
  claimNextCleanupCandidate,
  claimNextConversationTurn,
  claimNextDirectCommand,
  claimNextRejectedTask,
  claimNextResumableTask,
  claimNextRetryableTask,
  claimNextTask,
  failConversationTurn,
  getConversation,
  getTaskWithDeps,
  getPool,
  getWorkerRuntime,
  heartbeatWorker,
  listActiveTaskIdsForWorker,
  listCancelRequestedConversationMessages,
  listCancelRequestedTaskIds,
  listConversationMessages,
  listProjects,
  listTaskComments,
  listTaskEvents,
  listWorkerConversations,
  listWorkerProjectLinks,
  listWorkerTasks,
  markConversationTurnCancelled,
  markTaskCancelled,
  registerWorker,
  rejectTask,
  removeWorkerProjectLink,
  requestTaskCancellation,
  requestTaskRetry,
  setWorkerWorkingState,
  updateWorkerInfo,
  updateWorkerTerminal,
  upsertWorkerProjectLink,
  type Conversation,
  type ConversationMessage,
  type Task,
  type TaskComment,
  type TaskEvent,
  type WorkerProjectLinkView
} from "@claude-center/db";
import {
  persistWorkerState,
  projectLinkKey,
  readWorkerConfig,
  readWorkerState,
  type WorkerConfig,
  type WorkerProjectConfig
} from "./config.js";
import {
  cleanupMergedTask,
  executeConversationTurn,
  executeDirectCommand,
  executeTask,
  rerunRejectedTask,
  resumeTask,
  retryFailedTask,
  type ExecHooks
} from "./executor.js";
import {
  detectCapabilities,
  detectTerminals,
  inspectClaude,
  inspectOs,
  type Capabilities,
  type ClaudeInspect,
  type OsInfo,
  type TerminalInfo,
  type WorkerUsage
} from "./inspect.js";
import { killProcessTree } from "./shell.js";
import { gcWorktrees } from "./worktree.js";
import { WorkerRelay, type RelayStatus } from "./relay.js";
import { projectChannel, type RelayEvent } from "@claude-center/relay-client";

// 取消请求扫描间隔(ms):独立于工作态门控与认领循环,确保在执行中也能及时响应取消。
const CANCEL_INTERVAL_MS = 3_000;
// 孤儿 worktree GC 周期(ms):inline 清理(任务进终态即拆)是主路径,本定时器只兜底
// 「进程崩溃/异常退出留下、不在活跃集里」的孤树。低频即可,避免长跑 worker 磁盘渐进泄漏。
const GC_INTERVAL_MS = 30 * 60_000;
// 桌面日志面板的内存日志环容量。
const LOG_RING_CAPACITY = 200;

// 桌面端展示用:单条在途执行的摘要(兼做取消的索引来源)。
export type ActiveTaskView = {
  key: string;
  taskId: string | null;
  kind: "task" | "command" | "cleanup";
  title: string;
  startedAt: string;
  cancelled: boolean;
};

export type LogLine = { ts: string; level: "info" | "error"; message: string };

// 一条在途执行的内部跟踪:promise + 元信息 + Claude 子进程句柄(供取消杀进程)+ 取消标记。
type ActiveEntry = {
  promise: Promise<void>;
  taskId: string | null;
  kind: "task" | "command" | "cleanup";
  title: string;
  startedAt: string;
  child: ChildProcess | null;
  cancelled: boolean;
};

// 暴露给桌面端（Electron）展示与开关用的状态快照。
export type WorkerStatusSnapshot = {
  workerName: string;
  hostName: string;
  workingState: "idle" | "working";
  allowRemoteControl: boolean;
  maxParallel: number;
  activeCount: number;
  claudeVersion: string | null;
  subscriptionType: string;
  usage: WorkerUsage;
  capabilities: Capabilities;
  // worker 所在机器的操作系统概览 + 当前运行终端配置（桌面端展示 / 回显）。
  os: OsInfo;
  terminalCommand: string;
  claudePreCommand: string;
  activeTasks: ActiveTaskView[];
  logs: LogLine[];
  // SSE 中转连接状态 + 当前订阅频道数（桌面端展示连通性）。
  relayState: RelayStatus;
  relayChannels: number;
};

const UNKNOWN_CAPABILITY = { ok: false, version: null };

export class ClaudeCenterWorker {
  private readonly config: WorkerConfig;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private infoTimer: NodeJS.Timeout | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;
  private gcTimer: NodeJS.Timeout | null = null;
  // GC 重入护栏:周期触发,若上一轮未跑完则跳过本轮。
  private gcRunning = false;
  // 仅护住「认领循环」，不护执行：执行 fire-and-forget 进 active 跟踪，实现真并发。
  private claiming = false;
  // 对话独立车道：≤1 轮在途、不占任务并发槽、不受工作态门控（用户显式点名了这个 worker，idle 也应答）。
  private conversationBusy = false;
  // 在跑的对话轮：messageId + conversationId + Claude 子进程句柄 + 已取消标记，供 Console 端「终止本轮回答」杀进程。
  private conversationActive: {
    messageId: string;
    conversationId: string;
    child: ChildProcess | null;
    cancelled: boolean;
  } | null = null;
  private readonly relay: WorkerRelay;
  // 本机当前关联的项目 id 集（订阅 project 频道 + worker.upserted 扇出用）。
  private linkedProjectIds: string[] = [];
  private readonly active = new Map<string, ActiveEntry>();
  private lastInspect: ClaudeInspect = { claudeVersion: null, subscriptionType: "unknown", usage: {} };
  // 上次真去打 oauth/usage 的时刻（ms epoch）；按 usageIntervalMs 慢节奏控制，避免 60s 高频被限流。0=尚未采集。
  private lastUsageFetchAt = 0;
  // 启动时一次性自检的外部命令可用性;register/快照/任务预检都用它。
  private capabilities: Capabilities = {
    git: UNKNOWN_CAPABILITY,
    gh: UNKNOWN_CAPABILITY,
    claude: UNKNOWN_CAPABILITY
  };
  private readonly logs: LogLine[] = [];
  // 操作系统概览静态不变,启动时算一次。
  private readonly os: OsInfo = inspectOs();

  constructor(config = readWorkerConfig()) {
    this.config = config;
    this.relay = new WorkerRelay(config, (event) => this.onRelaySignal(event), (level, message) => this.log(level, message));
  }

  async start(): Promise<void> {
    this.capabilities = await detectCapabilities(this.config);
    this.log("info", `Capabilities — git:${this.cap("git")} gh:${this.cap("gh")} claude:${this.cap("claude")}`);
    if (!this.capabilities.claude.ok) {
      this.log("error", "claude CLI not detected on this worker — tasks will fail until it is installed / on PATH");
    }

    await this.register();
    await this.gcOrphanWorktrees();
    // 拉取本机关联项目 → 订阅 worker:<id> + 各 project:<id> 频道（relayUrl 为空则 no-op）。
    await this.refreshLinkedProjects();
    await this.refreshInfo();
    await this.tick();
    await this.tickConversation();

    this.heartbeatTimer = setInterval(() => {
      heartbeatWorker(getPool(), this.config.workerId).catch((error) => this.log("error", `heartbeat: ${error}`));
      void this.publishWorkerUpserted();
    }, this.config.heartbeatIntervalMs);

    this.infoTimer = setInterval(() => {
      this.refreshInfo().catch((error) => this.log("error", `refreshInfo: ${error}`));
    }, this.config.infoIntervalMs);

    this.pollTimer = setInterval(() => {
      this.tick().catch((error) => this.log("error", `tick: ${error}`));
      this.tickConversation().catch((error) => this.log("error", `tickConversation: ${error}`));
    }, this.config.pollIntervalMs);

    this.cancelTimer = setInterval(() => {
      this.handleCancellations().catch((error) => this.log("error", `cancel: ${error}`));
      this.handleConversationCancellations().catch((error) => this.log("error", `conv cancel: ${error}`));
    }, CANCEL_INTERVAL_MS);

    // 周期 GC 兜底:启动已跑过一次(上面),此后低频重扫,清理崩溃残留的孤儿任务树。
    this.gcTimer = setInterval(() => {
      void this.gcOrphanWorktrees();
    }, GC_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.infoTimer) clearInterval(this.infoTimer);
    if (this.cancelTimer) clearInterval(this.cancelTimer);
    if (this.gcTimer) clearInterval(this.gcTimer);
    this.relay.stop();
  }

  // —— 桌面端开关 —— //

  // 本地切换工作态（viaRemote 默认 false，不受 allow_remote_control 约束）。切到 working 立即催一次认领。
  async setWorkingState(state: "idle" | "working"): Promise<void> {
    await setWorkerWorkingState(getPool(), this.config.workerId, state);
    void this.publishWorkerUpserted();
    if (state === "working") {
      void this.tick();
    }
  }

  // 客户端策略开关：是否允许 web 远程控制。改内存 + 持久化 worker.json + 立即上报 DB。
  async setAllowRemoteControl(allow: boolean): Promise<void> {
    this.config.allowRemoteControl = allow;
    persistWorkerState(this.config.dataDir, { allowRemoteControl: allow });
    await this.reportInfo();
  }

  // 调整真并发上限：内存 + 持久化 + 立即上报 DB（tick 每轮读 DB 的 max_parallel，故即时生效）。
  async setMaxParallel(value: number): Promise<void> {
    const next = Math.max(1, Math.floor(value));
    this.config.maxParallel = next;
    persistWorkerState(this.config.dataDir, { maxParallel: next });
    await this.reportInfo();
    void this.tick();
  }

  // 本机已装的可选运行终端，供桌面端下拉。
  async listTerminals(): Promise<TerminalInfo[]> {
    return detectTerminals();
  }

  // 设置运行 claude 的终端（可执行文件全路径，空=默认）。改内存 + 持久化 worker.json + 同步入库。
  async setTerminalCommand(command: string): Promise<void> {
    const next = command.trim();
    this.config.terminalCommand = next;
    persistWorkerState(this.config.dataDir, { terminalCommand: next });
    await updateWorkerTerminal(getPool(), this.config.workerId, next, this.config.claudePreCommand);
  }

  // 设置运行 claude 前在终端会话先执行的前置命令（VPN/代理/登录等）。改内存 + 持久化 worker.json + 同步入库。
  async setPreCommand(command: string): Promise<void> {
    const next = command.trim();
    this.config.claudePreCommand = next;
    persistWorkerState(this.config.dataDir, { claudePreCommand: next });
    await updateWorkerTerminal(getPool(), this.config.workerId, this.config.terminalCommand, next);
  }

  // —— 桌面端项目关联 —— //

  // 云端项目清单（供桌面端下拉选择关联目标）。
  async listCloudProjects(): Promise<{ id: string; name: string; repo_url: string; default_branch: string }[]> {
    const projects = await listProjects(getPool());
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      repo_url: project.repo_url,
      default_branch: project.default_branch
    }));
  }

  // 本 worker 当前的项目关联（含项目展示信息）。
  async listProjectLinks(): Promise<WorkerProjectLinkView[]> {
    return listWorkerProjectLinks(getPool(), this.config.workerId);
  }

  // 桌面端添加一条本地项目关联：持久化进 worker.json（source=local）+ 内存 + 注册到 DB。
  async addProjectLink(input: { projectName: string; localPath: string }): Promise<void> {
    const project: WorkerProjectConfig = {
      projectName: input.projectName,
      localPath: input.localPath,
      source: "local"
    };
    const key = projectLinkKey(project);

    const persisted = readWorkerState(this.config.dataDir).projects ?? [];
    if (!persisted.some((item) => projectLinkKey(item) === key)) {
      persistWorkerState(this.config.dataDir, {
        projects: [...persisted, { projectName: input.projectName, localPath: input.localPath }]
      });
    }
    if (!this.config.projects.some((item) => projectLinkKey(item) === key)) {
      this.config.projects.push(project);
    }

    await upsertWorkerProjectLink(getPool(), {
      workerId: this.config.workerId,
      projectName: input.projectName,
      localPath: input.localPath
    });
    this.log("info", `Linked project ${input.projectName} → ${input.localPath}`);
    void this.refreshLinkedProjects();
    void this.tick();
  }

  // 桌面端移除一条本地项目关联：从 worker.json + 内存 + DB 同步删除。
  async removeProjectLink(input: { projectName: string; localPath: string }): Promise<void> {
    const key = projectLinkKey({ projectName: input.projectName, localPath: input.localPath });

    const persisted = readWorkerState(this.config.dataDir).projects ?? [];
    persistWorkerState(this.config.dataDir, {
      projects: persisted.filter((item) => projectLinkKey(item) !== key)
    });
    this.config.projects = this.config.projects.filter((item) => projectLinkKey(item) !== key);

    await removeWorkerProjectLink(getPool(), {
      workerId: this.config.workerId,
      projectName: input.projectName,
      localPath: input.localPath
    });
    this.log("info", `Unlinked project ${input.projectName} → ${input.localPath}`);
    void this.refreshLinkedProjects();
  }

  // 桌面端取消一个在途任务：打取消请求戳 + 立即扫描处理一轮（杀进程并翻终态）。返回是否为可取消的在途任务。
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await requestTaskCancellation(getPool(), taskId);
    await this.handleCancellations();
    return Boolean(task);
  }

  // —— 桌面端任务面板（Agent-View 式）：仅本 worker（claimed_by=workerId）的任务总览 + 本机回复/打回/验收 —— //

  // 本 worker 认领过的全部任务，供桌面端按状态分组展示。
  async listMyTasks(): Promise<Task[]> {
    return listWorkerTasks(getPool(), this.config.workerId);
  }

  // 某任务的评论 + 事件流，供桌面端 peek 展开。
  async getTaskDetail(taskId: string): Promise<{ comments: TaskComment[]; events: TaskEvent[] }> {
    const pool = getPool();
    const [comments, events] = await Promise.all([listTaskComments(pool, taskId), listTaskEvents(pool, taskId)]);
    return { comments, events };
  }

  // 对等待中（waiting）任务回复：落一条 user 评论，下一轮认领循环经 getPendingReply 续接同一会话。
  async replyToTask(taskId: string, body: string): Promise<void> {
    const text = body.trim();
    if (!text) {
      return;
    }
    await addTaskComment(getPool(), { taskId, author: "user", workerId: null, body: text });
    void this.tick();
  }

  // 打回待审（success）任务重跑：事务内落打回意见 + 翻 rejected（与 Console review 同路径），
  // 下一轮 claimNextRejectedTask 续接重跑。返回 false = 任务已不在 success 态（被并发验收/合并）。
  async rejectMyTask(taskId: string, feedback: string): Promise<boolean> {
    const text = feedback.trim();
    if (!text) {
      return false;
    }
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await rejectTask(client, taskId, text);
      if (!task) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("COMMIT");
      void this.tick();
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // 重试失败/取消任务:置 retry_requested_at,下一轮 claimNextRetryableTask 续接重跑。
  // 返回 false = 任务已不在 failed/cancelled 态（被并发激活/删除）。
  async retryMyTask(taskId: string): Promise<boolean> {
    const task = await requestTaskRetry(getPool(), taskId);
    if (task) {
      void this.tick();
    }
    return Boolean(task);
  }

  // 验收通过待审（success）任务：事务内翻为终态 accepted。返回 false = 任务已不在 success 态。
  async acceptMyTask(taskId: string): Promise<boolean> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const task = await acceptTask(client, taskId);
      if (!task) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // —— 桌面端「对话」面板（只读）：本 worker 承接的远程实时对话总览 + 消息线回放 —— //

  // 本 worker 的全部会话（含 generating / last_message_at 派生），供桌面端按状态分组展示。
  async listMyConversations(): Promise<Conversation[]> {
    return listWorkerConversations(getPool(), this.config.workerId);
  }

  // 某会话的消息线（桌面端只读回显）。回复中的 assistant body 尚空（终态才落最终全文），桌面端据 status 显示
  // 「回复中」；富展示（工具调用/thinking）走 Console 的 conversation_sessions jsonl，本面板不重复实现。
  async getConversationDetail(conversationId: string): Promise<{ messages: ConversationMessage[] }> {
    const messages = await listConversationMessages(getPool(), conversationId);
    return { messages };
  }

  async getStatusSnapshot(): Promise<WorkerStatusSnapshot> {
    const runtime = await getWorkerRuntime(getPool(), this.config.workerId).catch(() => null);
    return {
      workerName: this.config.workerName,
      hostName: this.config.hostName,
      workingState: runtime?.working_state ?? "idle",
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: runtime?.max_parallel ?? this.config.maxParallel,
      activeCount: this.active.size,
      claudeVersion: this.lastInspect.claudeVersion,
      subscriptionType: this.lastInspect.subscriptionType,
      usage: this.lastInspect.usage,
      capabilities: this.capabilities,
      os: this.os,
      terminalCommand: this.config.terminalCommand,
      claudePreCommand: this.config.claudePreCommand,
      activeTasks: [...this.active.entries()].map(([key, entry]) => ({
        key,
        taskId: entry.taskId,
        kind: entry.kind,
        title: entry.title,
        startedAt: entry.startedAt,
        cancelled: entry.cancelled
      })),
      logs: this.logs,
      relayState: this.relay.state,
      relayChannels: this.relay.channelCount
    };
  }

  // 桌面端「清理日志」：清空内存日志环。日志仅存内存（不落库），清理即彻底移除。
  clearLogs(): void {
    this.logs.length = 0;
  }

  // —— 内部 —— //

  private cap(name: keyof Capabilities): string {
    const capability = this.capabilities[name];
    return capability.ok ? capability.version ?? "ok" : "missing";
  }

  private log(level: "info" | "error", message: string): void {
    const line: LogLine = { ts: new Date().toISOString(), level, message };
    this.logs.push(line);
    if (this.logs.length > LOG_RING_CAPACITY) {
      this.logs.shift();
    }
    if (level === "error") {
      console.error(message);
    } else {
      console.log(message);
    }
  }

  private async register(): Promise<void> {
    const pool = getPool();
    await registerWorker(pool, {
      id: this.config.workerId,
      name: this.config.workerName,
      hostName: this.config.hostName,
      appVersion: this.config.appVersion,
      capabilities: {
        git: this.capabilities.git,
        gh: this.capabilities.gh,
        claude: this.capabilities.claude
      },
      metadata: {
        projectCount: this.config.projects.length
      },
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: this.config.maxParallel,
      terminalCommand: this.config.terminalCommand,
      claudePreCommand: this.config.claudePreCommand
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

  // 清理残留工作树：任务已进终态（不在 active 集）的工作树删掉，避免 worktrees 目录无限增长。
  // 启动时跑一次 + 此后每 GC_INTERVAL_MS 周期兜底（崩溃/异常退出留下的孤树）。gcRunning 防重入。
  private async gcOrphanWorktrees(): Promise<void> {
    if (this.gcRunning) {
      return;
    }
    this.gcRunning = true;
    try {
      const activeIds = await listActiveTaskIdsForWorker(getPool(), this.config.workerId);
      const keep = new Set(activeIds);
      for (const project of this.config.projects) {
        await gcWorktrees(project.localPath, keep);
      }
    } catch (error) {
      this.log("error", `gcOrphanWorktrees: ${error}`);
    } finally {
      this.gcRunning = false;
    }
  }

  // 采集 claude 版本/订阅/用量 + 当前客户端策略，写入 DB 供 Console 展示。
  // 版本/订阅每轮（infoIntervalMs，默认 60s）都刷；远程 oauth/usage 单独按 usageIntervalMs（默认 5min）慢刷，
  // 其余轮沿用上轮用量——避免高频打爆该接口触发 rate_limit_error。仅在真采集的轮次打 Usage 日志，免刷屏。
  private async refreshInfo(): Promise<void> {
    const now = Date.now();
    const refreshUsage = now - this.lastUsageFetchAt >= this.config.usageIntervalMs;
    if (refreshUsage) this.lastUsageFetchAt = now;
    this.lastInspect = await inspectClaude(this.config, {
      previousUsage: this.lastInspect.usage,
      refreshUsage
    });
    if (refreshUsage) this.logUsage();
    await this.reportInfo();
  }

  // 把套餐用量采集结果打到日志面板：成功显示百分比，失败显示原因（代理被挡 / token 失效等），
  // 让「套餐账号却没用量」可被直接看出，而非永远空着无从排查。
  private logUsage(): void {
    const { subscriptionType, usage } = this.lastInspect;
    // 非套餐账号本就不采集用量，不打扰日志。
    if (subscriptionType === "api" || subscriptionType === "unknown") {
      return;
    }
    if (usage.five_hour || usage.seven_day) {
      const five = usage.five_hour ? `5h ${usage.five_hour.utilization}%` : "5h —";
      const seven = usage.seven_day ? `7d ${usage.seven_day.utilization}%` : "7d —";
      // 有窗口又带 error：本轮采集失败（如限流），沿用上轮数据，info 轻提示而非报红。
      const stale = usage.error ? `（本轮采集失败，沿用上次：${usage.error}）` : "";
      this.log("info", `Usage — ${five} · ${seven}${stale}`);
    } else {
      this.log(
        "error",
        `Usage 采集失败（${subscriptionType} 套餐）：${usage.error ?? "未知原因"}` +
          (this.config.usageProxy ? "" : "；当前未配置 CLAUDE_CENTER_USAGE_PROXY，直连 api.anthropic.com 可能被挡")
      );
    }
  }

  // 仅上报当前已知的动态信息 + 客户端策略（不重新采集 claude）。开关/并发改动后即时落库用。
  private async reportInfo(): Promise<void> {
    await updateWorkerInfo(getPool(), this.config.workerId, {
      claudeVersion: this.lastInspect.claudeVersion,
      subscriptionType: this.lastInspect.subscriptionType,
      usage: this.lastInspect.usage,
      allowRemoteControl: this.config.allowRemoteControl,
      maxParallel: this.config.maxParallel
    });
    void this.publishWorkerUpserted();
  }

  // —— SSE 中转（relay）：订阅信号驱动即时 tick + 各生命周期点落库后 best-effort 发布 —— //

  // 收到外部（非自己发出）的中转信号即催一次相应车道；各车道都有 busy/工作态守卫，重复触发安全。
  private onRelaySignal(event: RelayEvent): void {
    if (event.type === "conversation.cancel") {
      void this.handleConversationCancellations();
      return;
    }
    if (event.type === "conversation.message" || event.type === "conversation.upserted") {
      void this.tickConversation();
      return;
    }
    void this.tick();
    void this.tickConversation();
    void this.handleCancellations();
  }

  // 拉取本机关联项目 id，更新 worker.upserted 扇出范围并据此（重新）订阅 project 频道。
  private async refreshLinkedProjects(): Promise<void> {
    try {
      const links = await listWorkerProjectLinks(getPool(), this.config.workerId);
      this.linkedProjectIds = [...new Set(links.filter((link) => link.enabled).map((link) => link.project_id))];
      this.relay.subscribe(this.linkedProjectIds);
    } catch (error) {
      this.log("error", `relay refreshLinks: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 推一行任务（full payload）到其项目频道。
  private publishTask(task: Task): void {
    this.relay.publish({
      channel: projectChannel(task.project_id),
      type: "task.upserted",
      entityId: task.id,
      projectId: task.project_id,
      seq: task.updated_at,
      payload: task
    });
  }

  // 取最新落库任务行后再推（执行进终态 / 取消后）。
  private async publishTaskById(taskId: string): Promise<void> {
    if (!this.relay.enabled) {
      return;
    }
    try {
      const result = await getTaskWithDeps(getPool(), taskId);
      if (result) {
        this.publishTask(result.task);
      }
    } catch (error) {
      this.log("error", `relay publishTask ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 认领对话轮时推：会话头（进入回复中）+ 该 assistant 轮消息（streaming 占位）。
  private publishConversationTurn(conversation: Conversation, message: ConversationMessage): void {
    if (!this.relay.enabled) {
      return;
    }
    const channel = projectChannel(conversation.project_id);
    this.relay.publish({
      channel,
      type: "conversation.upserted",
      entityId: conversation.id,
      projectId: conversation.project_id,
      payload: conversation
    });
    this.relay.publish({
      channel,
      type: "conversation.message",
      entityId: conversation.id,
      projectId: conversation.project_id,
      seq: message.seq,
      payload: message
    });
  }

  // 对话轮收尾后推：最新会话头 + 助手终态消息（full payload）。
  private async publishConversationFinal(conversationId: string): Promise<void> {
    if (!this.relay.enabled) {
      return;
    }
    try {
      const pool = getPool();
      const conversation = await getConversation(pool, conversationId);
      if (!conversation) {
        return;
      }
      const channel = projectChannel(conversation.project_id);
      this.relay.publish({
        channel,
        type: "conversation.upserted",
        entityId: conversation.id,
        projectId: conversation.project_id,
        payload: conversation
      });
      const messages = await listConversationMessages(pool, conversationId);
      const last = messages[messages.length - 1];
      if (last) {
        this.relay.publish({
          channel,
          type: "conversation.message",
          entityId: conversation.id,
          projectId: conversation.project_id,
          seq: last.seq,
          payload: last
        });
      }
    } catch (error) {
      this.log("error", `relay publishConv ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 推 worker 摘要到所有关联项目频道（Console 执行机群列表/详情秒级更新）。
  private async publishWorkerUpserted(): Promise<void> {
    if (!this.relay.enabled || !this.linkedProjectIds.length) {
      return;
    }
    try {
      const runtime = await getWorkerRuntime(getPool(), this.config.workerId).catch(() => null);
      const payload = {
        id: this.config.workerId,
        name: this.config.workerName,
        host_name: this.config.hostName,
        working_state: runtime?.working_state ?? "idle",
        max_parallel: runtime?.max_parallel ?? this.config.maxParallel,
        active_task_count: this.active.size
      };
      for (const projectId of this.linkedProjectIds) {
        this.relay.publish({
          channel: projectChannel(projectId),
          type: "worker.upserted",
          entityId: this.config.workerId,
          projectId,
          payload
        });
      }
    } catch (error) {
      this.log("error", `relay publishWorker: ${error instanceof Error ? error.message : String(error)}`);
    }
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

  // 对话车道：独立于任务 tick（不受工作态门控、不占并发槽）。≤1 轮在途，认领→流式执行→空闲后再催一次。
  private async tickConversation(): Promise<void> {
    if (this.conversationBusy) {
      return;
    }
    this.conversationBusy = true;
    const pool = getPool();
    try {
      const turn = await claimNextConversationTurn(pool, this.config.workerId);
      if (!turn) {
        this.conversationBusy = false;
        return;
      }
      const conv = await getConversation(pool, turn.conversation_id);
      if (!conv) {
        await failConversationTurn(pool, { messageId: turn.id, errorMessage: "conversation not found" });
        this.conversationBusy = false;
        return;
      }
      // 认领即推：让 Console 秒级看到该会话进入「回复中」。
      this.publishConversationTurn(conv, turn);
      // 跟踪在跑轮：onClaudeSpawn 回填 child（取消时 killProcessTree 用）。
      const active = { messageId: turn.id, conversationId: conv.id, child: null as ChildProcess | null, cancelled: false };
      this.conversationActive = active;
      // fire-and-forget：执行期间占住车道，完成后释放并再催一次（处理排队的新消息）。
      void executeConversationTurn(this.config, conv, turn, {
        claudeAvailable: this.capabilities.claude.ok,
        onClaudeSpawn: (child) => {
          active.child = child;
        }
      })
        .catch((error) => this.log("error", `conversation ${conv.id}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.conversationBusy = false;
          this.conversationActive = null;
          // 收尾后推最新会话头 + 助手终态消息（full payload），Console 秒级显示回复。
          void this.publishConversationFinal(conv.id);
          void this.tickConversation();
        });
    } catch (error) {
      this.conversationBusy = false;
      this.log("error", `tickConversation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 按优先级认领一个工作单元并启动执行；认领成功返回 true。
  private async claimAndStartOne(): Promise<boolean> {
    const pool = getPool();

    const command = await claimNextDirectCommand(pool, this.config.workerId);
    if (command) {
      this.startActive(
        { key: `cmd:${command.id}`, taskId: null, kind: "command", title: `指令 ${command.command}` },
        () => executeDirectCommand(this.config, command)
      );
      return true;
    }

    // 优先级:续接等待中任务 > 打回重跑 > 失败/取消续接重试 > 全新任务 > 合并清理。
    const resumable = await claimNextResumableTask(pool, this.config.workerId);
    if (resumable) {
      this.startActive(
        { key: `task:${resumable.id}`, taskId: resumable.id, kind: "task", title: resumable.title },
        (hooks) => resumeTask(this.config, resumable, hooks)
      );
      this.publishTask(resumable);
      return true;
    }

    const rejected = await claimNextRejectedTask(pool, this.config.workerId);
    if (rejected) {
      this.startActive(
        { key: `task:${rejected.id}`, taskId: rejected.id, kind: "task", title: rejected.title },
        (hooks) => rerunRejectedTask(this.config, rejected, hooks)
      );
      this.publishTask(rejected);
      return true;
    }

    // 用户请求重试的 failed/cancelled 任务(本机锁定,保留了工作树)续接重跑——优先级高于全新任务。
    const retryable = await claimNextRetryableTask(pool, this.config.workerId);
    if (retryable) {
      this.startActive(
        { key: `task:${retryable.id}`, taskId: retryable.id, kind: "task", title: retryable.title },
        (hooks) => retryFailedTask(this.config, retryable, hooks)
      );
      this.publishTask(retryable);
      return true;
    }

    const task = await claimNextTask(pool, this.config.workerId);
    if (task) {
      this.startActive(
        { key: `task:${task.id}`, taskId: task.id, kind: "task", title: task.title },
        (hooks) => executeTask(this.config, task, hooks)
      );
      this.publishTask(task);
      return true;
    }

    // 最低优先级：轮转检查一个已建 PR 的 success 任务是否已合并，合并则清理工作树/分支并转 merged。
    const cleanup = await claimNextCleanupCandidate(pool, this.config.workerId);
    if (cleanup) {
      this.startActive(
        { key: `cleanup:${cleanup.id}`, taskId: cleanup.id, kind: "cleanup", title: cleanup.title },
        () => cleanupMergedTask(this.config, cleanup)
      );
      this.publishTask(cleanup);
      return true;
    }

    return false;
  }

  // fire-and-forget 启动一个在途执行：建跟踪条目（含 Claude 子进程句柄回填 + 能力预检），完成后从 active 移除并催一次 tick。
  private startActive(
    meta: { key: string; taskId: string | null; kind: ActiveEntry["kind"]; title: string },
    run: (hooks: ExecHooks) => Promise<void>
  ): void {
    const entry: ActiveEntry = {
      promise: Promise.resolve(),
      taskId: meta.taskId,
      kind: meta.kind,
      title: meta.title,
      startedAt: new Date().toISOString(),
      child: null,
      cancelled: false
    };
    const hooks: ExecHooks = {
      claudeAvailable: this.capabilities.claude.ok,
      onClaudeSpawn: (child) => {
        entry.child = child;
      }
    };
    entry.promise = run(hooks)
      .catch((error) => this.log("error", `${meta.key}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.active.delete(meta.key);
        // 执行进终态后把最新任务行推给 Console（取最新落库状态，full payload）。
        if (meta.taskId) {
          void this.publishTaskById(meta.taskId);
        }
        void this.tick();
      });
    this.active.set(meta.key, entry);
  }

  // 对话取消：扫描本 worker 名下被请求终止的 assistant 轮 → 先抢占 cancelled 终态（防止 catch 路径里的 failConversationTurn 覆盖）→ 再杀 Claude 进程树。
  // 与任务取消同构（先 markTaskCancelled 再 killProcessTree），仅落点对象不同。
  private async handleConversationCancellations(): Promise<void> {
    const requested = await listCancelRequestedConversationMessages(getPool(), this.config.workerId);
    if (!requested.length) {
      return;
    }
    const wanted = new Set(requested.map((row) => row.id));
    const active = this.conversationActive;
    for (const row of requested) {
      try {
        const ok = await markConversationTurnCancelled(getPool(), row.id, this.config.workerId);
        // 只有正跑这条的车道才有 child 句柄可杀；其余情形（已完成 / 进程已退出）markConversationTurnCancelled 也会无副作用兜底。
        if (active && active.messageId === row.id && wanted.has(active.messageId)) {
          active.cancelled = true;
          if (active.child) {
            killProcessTree(active.child);
          }
        }
        if (ok) {
          this.log("info", `Conversation turn ${row.id} cancelled`);
        }
        void this.publishConversationFinal(row.conversation_id);
      } catch (error) {
        this.log("error", `conv cancel ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // 周期扫描:本 worker 名下被请求取消的在途任务 → 先抢占 cancelled 终态(防执行链 catch 的 markTaskFailed 覆盖)→ 再杀 Claude 进程树。
  private async handleCancellations(): Promise<void> {
    const ids = await listCancelRequestedTaskIds(getPool(), this.config.workerId);
    if (!ids.length) {
      return;
    }
    const wanted = new Set(ids);
    for (const entry of this.active.values()) {
      if (entry.kind !== "task" || !entry.taskId || entry.cancelled || !wanted.has(entry.taskId)) {
        continue;
      }
      entry.cancelled = true;
      try {
        const ok = await markTaskCancelled(getPool(), entry.taskId, this.config.workerId, {
          cancelledAt: new Date().toISOString(),
          reason: "user requested"
        });
        if (entry.child) {
          killProcessTree(entry.child);
        }
        this.log("info", `Task ${entry.taskId} cancelled (${ok ? "marked" : "already terminal"})`);
        if (entry.taskId) {
          void this.publishTaskById(entry.taskId);
        }
      } catch (error) {
        this.log("error", `cancel ${entry.taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
