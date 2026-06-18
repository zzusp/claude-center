import type { ChildProcess } from "node:child_process";
import {
  addTaskComment,
  claimNextConversationTurn,
  claimNextDirectCommand,
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
  listInflightConversationTurnsForWorker,
  getConversationSession,
  getConversationSessionSyncedAt,
  listConversationMessages,
  listProjects,
  listTaskComments,
  listTaskEvents,
  listWorkerConversations,
  listWorkerProjectLinks,
  listWorkerTasks,
  listWorkerTasksPaged,
  type TaskPage,
  markConversationTurnCancelled,
  markTaskCancelled,
  registerWorker,
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
  executeConversationTurn,
  executeDirectCommand,
  executeTask,
  finalizeConversationFromSession,
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
import { isSameProcessAlive, killByPid, killProcessTree } from "./shell.js";
import { startConversationSessionSync } from "./session.js";
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
  kind: "task" | "command";
  title: string;
  startedAt: string;
  cancelled: boolean;
};

export type LogLine = { ts: string; level: "info" | "error"; message: string };

// 一条在途执行的内部跟踪:promise + 元信息 + Claude 子进程句柄(供取消杀进程)+ 取消标记。
type ActiveEntry = {
  promise: Promise<void>;
  taskId: string | null;
  kind: "task" | "command";
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

const UNKNOWN_CAPABILITY = { ok: false, version: null, path: null };


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
  // 在跑的对话轮：messageId + conversationId + Claude 子进程句柄 + pid + 已取消标记，供 Console 端「终止本轮回答」杀进程。
  // child 为本进程派生时的句柄（正常 tick）；重启重连的轮无句柄、只有持久化的 pid（取消时按 pid 杀）。
  private conversationActive: {
    messageId: string;
    conversationId: string;
    child: ChildProcess | null;
    pid: number | null;
    // claude 进程的 OS 创建时间（仅重连轮有值，正常轮持 child 句柄、无需）。配合 pid 做身份校验防复用误杀。
    startedAt: number | null;
    cancelled: boolean;
  } | null = null;
  // 重连轮的 pid 存活轮询定时器（worker 重启时进程仍活的对话轮，靠轮询 pid 探测其退出后收尾）。
  private conversationReattachTimer: NodeJS.Timeout | null = null;
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
    claude: UNKNOWN_CAPABILITY,
    nodejs: UNKNOWN_CAPABILITY,
    python: UNKNOWN_CAPABILITY
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
    this.log("info", `Capabilities — git:${this.cap("git")} gh:${this.cap("gh")} claude:${this.cap("claude")} node:${this.cap("nodejs")} python:${this.cap("python")}`);
    if (!this.capabilities.claude.ok) {
      this.log("error", "claude CLI not detected on this worker — tasks will fail until it is installed / on PATH");
    }

    await this.register();
    await this.gcOrphanWorktrees();
    // 拉取本机关联项目 → 订阅 worker:<id> + 各 project:<id> 频道（relayUrl 为空则 no-op）。
    await this.refreshLinkedProjects();
    await this.refreshInfo();
    // 启动对账本机名下仍 in-flight 的对话轮（关机存活 + 重启重连，见 docs/spec/conversation-turn-survive-restart.md）：
    // claude 进程仍存活 → 重连（恢复 .jsonl 同步 + 轮询其退出后从 session 收尾）；已退 → 从 .jsonl 收尾或判 fail。
    // 必须在首个 tickConversation 之前跑（重连会占住对话车道）。
    await this.reconcileInflightConversationTurns();
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
    if (this.conversationReattachTimer) clearInterval(this.conversationReattachTimer);
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

  // —— 桌面端任务面板（Agent-View 式）：仅本 worker（claimed_by=workerId）的任务总览 + 本机回复/重试 —— //

  // 本 worker 认领过的任务（真分页 + 状态筛选），供桌面端任务面板使用。
  async listMyTasks(opts: { page: number; pageSize: number; statusGroup?: string | null }): Promise<TaskPage> {
    return listWorkerTasksPaged(getPool(), this.config.workerId, opts);
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

  // 重试失败/取消任务:置 retry_requested_at,下一轮 claimNextRetryableTask 续接重跑。
  // 返回 false = 任务已不在 failed/cancelled 态（被并发激活/删除）。
  async retryMyTask(taskId: string): Promise<boolean> {
    const task = await requestTaskRetry(getPool(), taskId);
    if (task) {
      void this.tick();
    }
    return Boolean(task);
  }

  // —— 桌面端「对话」面板（只读）：本 worker 承接的远程实时对话总览 + 消息线回放 —— //

  // 本 worker 的全部会话（含 generating / last_message_at 派生），供桌面端按状态分组展示。
  async listMyConversations(): Promise<Conversation[]> {
    return listWorkerConversations(getPool(), this.config.workerId);
  }

  // 某会话的消息线 + session JSONL（桌面端 transcript 富展示，对齐 Console 渲染方式）。
  // H2 条件拉取：先用 synced_at 做轻量版本判定，未变（knownJsonlVersion 命中）则 jsonl 回传 null，
  // 跳过 571KB blob 的 DB 读 + IPC 传输；渲染端复用本地缓存。session 每 3s 才同步一次，而桌面端 400ms
  // 轮询 → 多数轮次走这条空回，省下绝大部分大 blob 流量。
  async getConversationDetail(
    conversationId: string,
    knownJsonlVersion?: string | null
  ): Promise<{ messages: ConversationMessage[]; jsonl: string | null; jsonlVersion: string }> {
    const pool = getPool();
    const messages = await listConversationMessages(pool, conversationId);
    const syncedAt = await getConversationSessionSyncedAt(pool, conversationId);
    const version = syncedAt ? String(new Date(syncedAt).getTime()) : "";
    if (version && version === knownJsonlVersion) {
      return { messages, jsonl: null, jsonlVersion: version };
    }
    const session = await getConversationSession(pool, conversationId);
    return { messages, jsonl: session?.jsonl ?? "", jsonlVersion: version };
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
      // 跟踪在跑轮：onClaudeSpawn 回填 child + pid（取消时 killProcessTree 用；pid 也供重连轮取消按 pid 杀）。
      const active = { messageId: turn.id, conversationId: conv.id, child: null as ChildProcess | null, pid: null as number | null, startedAt: null as number | null, cancelled: false };
      this.conversationActive = active;
      // fire-and-forget：执行期间占住车道，完成后释放并再催一次（处理排队的新消息）。
      void executeConversationTurn(this.config, conv, turn, {
        claudeAvailable: this.capabilities.claude.ok,
        onClaudeSpawn: (child) => {
          active.child = child;
          active.pid = child.pid ?? null;
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

  // 启动对账本机名下仍 in-flight 的对话轮（关机存活 + 重启重连）：
  //  · claude_pid 仍存活 → 重连：占住对话车道 + 恢复 .jsonl 同步 + 轮询其退出后从 session 收尾（首条命中即占满车道）；
  //  · 已退/未记 pid → 从 .jsonl 收尾（有完整回答则 done），否则 failConversationTurn。
  // best-effort：失败仅记日志，不阻塞启动。详见 docs/spec/conversation-turn-survive-restart.md。
  private async reconcileInflightConversationTurns(): Promise<void> {
    let turns: { id: string; conversation_id: string; claude_pid: number | null; claude_cwd: string | null; claude_started_at: number | null }[] = [];
    try {
      turns = await listInflightConversationTurnsForWorker(getPool(), this.config.workerId);
    } catch (error) {
      this.log("error", `reconcileInflightConversationTurns: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    let reattached = false;
    for (const turn of turns) {
      // 身份校验：pid 存活且创建时间精确匹配，才是「当初那个 claude」。pid 被复用（创建时间不同）一律按已退处理，
      // 杜绝误连到别的 running 进程（如另一个 claude session）。
      const alive = await isSameProcessAlive(turn.claude_pid, turn.claude_started_at);
      if (alive && !reattached) {
        reattached = true;
        this.log("info", `boot: 重连在途对话轮 ${turn.id}（claude pid=${turn.claude_pid} 仍在跑）`);
        this.reattachConversationTurn(turn);
        continue;
      }
      if (alive) {
        // 罕见：对话车道应 ≤1 在途轮。多出的存活轮先留着（下次重启再处理），不动它。
        this.log("info", `boot: 跳过额外存活对话轮 ${turn.id}（车道已被占）`);
        continue;
      }
      // 进程已退（停机期间跑完/崩溃）：从 .jsonl 收尾，无完整回答则判 fail。
      await this.finalizeOrFailReconnect(turn);
    }
  }

  // 进程已退的在途轮：cwd 有 .jsonl 且含完整 assistant 回答 → finalize done；否则 fail。然后推会话头刷新 Console。
  private async finalizeOrFailReconnect(turn: { id: string; conversation_id: string; claude_cwd: string | null }): Promise<void> {
    const pool = getPool();
    try {
      const done = turn.claude_cwd
        ? await finalizeConversationFromSession(pool, { conversationId: turn.conversation_id, messageId: turn.id, cwd: turn.claude_cwd })
        : false;
      if (!done) {
        await failConversationTurn(pool, { messageId: turn.id, errorMessage: "worker 重启时该轮 claude 进程已退出且无完整结果" });
      }
      this.log("info", `boot: 在途对话轮 ${turn.id} 进程已退 → ${done ? "从 session 收尾(done)" : "判 fail"}`);
    } catch (error) {
      this.log("error", `finalizeOrFailReconnect ${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      void this.publishConversationFinal(turn.conversation_id);
    }
  }

  // 重连一条仍存活的在途轮：占住对话车道、恢复 .jsonl 同步、轮询 pid；进程退出即从 session 收尾（除非已被取消）。
  private reattachConversationTurn(turn: { id: string; conversation_id: string; claude_pid: number | null; claude_cwd: string | null; claude_started_at: number | null }): void {
    const pid = turn.claude_pid;
    const cwd = turn.claude_cwd;
    const startedAt = turn.claude_started_at;
    if (pid == null || !cwd) {
      return;
    }
    this.conversationBusy = true;
    const active = { messageId: turn.id, conversationId: turn.conversation_id, child: null as ChildProcess | null, pid, startedAt, cancelled: false };
    this.conversationActive = active;
    // 恢复 .jsonl → conversation_sessions 周期同步，让 Console 继续看到流式增量。
    const stopSync = startConversationSessionSync(turn.conversation_id, cwd);
    // 推一次会话头，让重连后 Console 立即恢复生成态（turn 仍 streaming → generating 派生为 true）。
    void this.publishConversationFinal(turn.conversation_id);
    const done = async (): Promise<void> => {
      if (this.conversationReattachTimer) {
        clearInterval(this.conversationReattachTimer);
        this.conversationReattachTimer = null;
      }
      await stopSync().catch(() => {});
      try {
        if (!active.cancelled) {
          const ok = await finalizeConversationFromSession(getPool(), { conversationId: turn.conversation_id, messageId: turn.id, cwd });
          if (!ok) {
            await failConversationTurn(getPool(), { messageId: turn.id, errorMessage: "重连的 claude 进程已退出但无完整结果" });
          }
        }
      } catch (error) {
        this.log("error", `reattach finalize ${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (this.conversationActive === active) {
          this.conversationActive = null;
        }
        this.conversationBusy = false;
        void this.publishConversationFinal(turn.conversation_id);
        void this.tickConversation();
      }
    };
    // 轮询进程身份：无 child 句柄拿不到 exit 事件，只能探活。用 isSameProcessAlive（pid + 创建时间）而非裸 pid——
    // 否则 claude 退出后 pid 被复用会让轮询误判「还在跑」而永不收尾、甚至取消时误杀复用进程。
    // isSameProcessAlive 异步（要查进程创建时间），加 inflight 锁防重入。
    let checking = false;
    this.conversationReattachTimer = setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      void (async () => {
        try {
          if (!(await isSameProcessAlive(pid, startedAt))) {
            await done();
          }
        } finally {
          checking = false;
        }
      })();
    }, CANCEL_INTERVAL_MS);
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

    // 优先级:续接等待中任务 > 失败/取消续接重试 > 全新任务。
    // 「打回重跑」「合并清理」分支均已移除——前者随人工验收一起去掉,后者由 Console 30s 轮询 + 翻 merged
    // 直接完成,Worker 不再做 worktree/分支清理(spec docs/spec/drop-accepted-rejected.md)。
    const resumable = await claimNextResumableTask(pool, this.config.workerId);
    if (resumable) {
      this.startActive(
        { key: `task:${resumable.id}`, taskId: resumable.id, kind: "task", title: resumable.title },
        (hooks) => resumeTask(this.config, resumable, hooks)
      );
      this.publishTask(resumable);
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
          } else if (active.pid != null) {
            // 重连的在途轮无 ChildProcess 句柄，只有持久化的 pid。杀之前先校验进程身份（pid + 创建时间），
            // 防 pid 被复用后误杀别的进程（如另一个 running 的 claude session）——这是 pid 复用最严重的后果。
            if (await isSameProcessAlive(active.pid, active.startedAt)) {
              killByPid(active.pid);
            }
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
