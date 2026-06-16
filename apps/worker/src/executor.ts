import {
  addTaskComment,
  addTaskEvent,
  failConversationTurn,
  finalizeConversationTurn,
  getConversationLocalPath,
  getConversationPrompt,
  getPendingReply,
  getPool,
  getTaskLocalPath,
  markDirectCommandFailed,
  markDirectCommandRunning,
  markDirectCommandSuccess,
  markTaskFailed,
  markTaskMerged,
  markTaskRunning,
  markTaskSuccess,
  setTaskClaudeSession,
  setTaskMergeChecked,
  setTaskWaiting,
  type Conversation,
  type ConversationMessage,
  type DirectCommand,
  type Task
} from "@claude-center/db";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { runCommand, type CommandResult } from "./shell.js";
import {
  buildClaudeScript,
  buildTerminalScript,
  CLAUDE_ENV,
  defaultTerminalCommand,
  isWsl,
  shellFamily,
  terminalLaunch
} from "./terminal.js";
import { conversationWorktreePathFor, ensureWorktree, removeWorktree, worktreePathFor } from "./worktree.js";
import { startConversationSessionSync, startTaskSessionSync } from "./session.js";

const CLAUDE_TIMEOUT_MS = 60 * 60_000;
// 定向 shell 指令的执行上限（沿用原 runPowerShell 的 20 分钟）。
const SHELL_COMMAND_TIMEOUT_MS = 20 * 60_000;

// runner 注入的执行钩子:onClaudeSpawn 暴露 Claude 子进程供取消时杀进程树;
// claudeAvailable 来自启动能力自检,false 时任务在跑 Claude 前就以清晰错误失败。
export type ExecHooks = {
  onClaudeSpawn?: (child: ChildProcess) => void;
  claudeAvailable?: boolean;
};

function ensureClaudeAvailable(hooks?: ExecHooks): void {
  if (hooks && hooks.claudeAvailable === false) {
    throw new Error(
      "claude CLI not found on this worker. Install Claude Code and ensure `claude` is on PATH (or set CLAUDE_CODE_COMMAND)."
    );
  }
}

// Claude 在 headless 模式下没有内建「需要提问」信号，约定这个哨兵：需要用户确认时
// Claude 在回复末尾输出该串 + 问题后停止，Worker 解析后落为评论并等待回复。
const NEEDS_INPUT_SENTINEL = "<<CLAUDE_CENTER_NEEDS_INPUT>>";

// auto_reply 模式（task.auto_reply=true）的兜底常量。主防线是激进版 prompt（哨兵被重新定义为"任务被
// 判定 blocked"），仍出哨兵时按 worktree 是否有改动分流：零改动→直接 fail；有改动→自动塞一条 user
// 评论让现有 resumable 流续接，最多 AUTO_REPLY_MAX_ROUNDS 轮，超出立刻 fail。值故意调小（cap=2），
// 因为进入兜底说明主防线没拦住、再宽容也只是烧 token；如需调整改这一处即可。
const AUTO_REPLY_MAX_ROUNDS = 2;
const AUTO_REPLY_CANNED =
  "Commit what you have and finish in one shot. Use your best judgment for any remaining decisions; document them in the commit message body.";

async function countAutoReplyRounds(taskId: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM task_events WHERE task_id = $1 AND event_type = 'auto_reply'`,
    [taskId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

type ClaudeTurn = { sessionId: string | null; result: string; raw: CommandResult };

type ClaudeCallOpts = {
  prompt: string;
  cwd?: string;
  resumeSessionId?: string;
  model?: string;
  onSpawn?: (child: ChildProcess) => void;
  // true=任务执行（带 --settings / --append-system-prompt-file / --permission-mode / --output-format json）；
  // false=定向 claude 指令（仅 `-p <prompt>`，跟随 claude 默认）。
  full: boolean;
};

// 统一的 claude 调用：按运行终端配置选执行形态。
// - 直接形态（默认终端 + 无前置命令）：spawn(claude, argv)，无 shell 解析，最稳，等同旧行为。
// - 终端形态（配了前置命令 或 自定义终端）：在所选终端的一个会话里跑 `<前置命令> <sep> <claude 调用>`，
//   使前置命令（VPN/代理/登录）设置的环境被 claude 继承。prompt/路径/claude 路径经 env 传入并按终端
//   家族安全引用（空格/引号/换行不破坏）；model/session-id(UUID)/permission-mode/output-format 为
//   无 shell 元字符的安全字面量，内联。终端可执行文件 shell:false spawn（含空格全路径安全）。
function spawnClaude(config: WorkerConfig, opts: ClaudeCallOpts): Promise<CommandResult> {
  // 'default' / 空 表示不指定 --model；其余为白名单别名（opus/sonnet/haiku），可安全内联。
  const modelArg = opts.model && opts.model !== "default" ? opts.model : null;
  const usesTerminal = config.claudePreCommand !== "" || config.terminalCommand !== "";

  if (!usesTerminal) {
    const args = [
      "-p",
      opts.prompt,
      ...(modelArg ? ["--model", modelArg] : []),
      ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : [])
    ];
    if (opts.full) {
      args.push(
        "--permission-mode",
        config.permissionMode,
        "--settings",
        config.claudeSettingsPath,
        "--append-system-prompt-file",
        config.claudeRulesPath,
        "--output-format",
        "json"
      );
    }
    return runCommand(config.claudeCommand, args, {
      cwd: opts.cwd,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onSpawn: opts.onSpawn
    });
  }

  const terminalCommand = config.terminalCommand || defaultTerminalCommand();
  const family = shellFamily(terminalCommand);
  const script = buildClaudeScript({
    family,
    full: opts.full,
    modelArg,
    resumeSessionId: opts.resumeSessionId,
    permissionMode: config.permissionMode,
    preCommand: config.claudePreCommand
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CLAUDE_ENV.CMD]: config.claudeCommand,
    [CLAUDE_ENV.PROMPT]: opts.prompt,
    [CLAUDE_ENV.SETTINGS]: config.claudeSettingsPath,
    [CLAUDE_ENV.RULES]: config.claudeRulesPath
  };
  // WSL 不继承 Windows 进程 env，需在 WSLENV 声明转发的变量名（冒号分隔）。
  if (isWsl(terminalCommand)) {
    const names = [CLAUDE_ENV.CMD, CLAUDE_ENV.PROMPT, CLAUDE_ENV.SETTINGS, CLAUDE_ENV.RULES].join(":");
    env.WSLENV = process.env.WSLENV ? `${process.env.WSLENV}:${names}` : names;
  }

  const launch = terminalLaunch(terminalCommand, script);
  // shell:false：终端含空格全路径作 argv[0] 安全，且脚本作单参不被 cmd.exe 二次解析。
  return runCommand(launch.cmd, launch.args, {
    cwd: opts.cwd,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    onSpawn: opts.onSpawn,
    shell: false,
    env
  });
}

// 任务执行用：`claude -p ... --output-format json`（+ 可选 --resume），解析 json 取 session/result。
function runClaudeJson(
  config: WorkerConfig,
  opts: {
    prompt: string;
    cwd?: string;
    resumeSessionId?: string;
    model?: string;
    onSpawn?: (child: ChildProcess) => void;
  }
): Promise<ClaudeTurn> {
  return spawnClaude(config, { ...opts, full: true }).then((raw) => {
    const parsed = parseClaudeJson(raw);
    return { sessionId: parsed.session_id ?? null, result: parsed.result ?? "", raw };
  });
}

// 任务执行入口：跑 claude 的同时周期同步会话 transcript 到 task_sessions，并在进程退出（成功/抛错/
// 超时/被取消 kill）后强制最终同步一次，再返回 turn 交调用方翻终态——保证 web 见终态时 transcript 完整。
function runTaskClaude(
  config: WorkerConfig,
  taskId: string,
  opts: {
    prompt: string;
    cwd: string;
    resumeSessionId?: string;
    model?: string;
    onSpawn?: (child: ChildProcess) => void;
  }
): Promise<ClaudeTurn> {
  const stopSync = startTaskSessionSync(taskId, opts.cwd);
  return runClaudeJson(config, opts).finally(() => stopSync());
}

function parseClaudeJson(raw: CommandResult): { session_id?: string; result?: string } {
  try {
    return JSON.parse(raw.stdout.trim()) as { session_id?: string; result?: string };
  } catch {
    throw new Error(
      `Failed to parse claude --output-format json output.\nstdout:\n${raw.stdout.slice(
        -2000
      )}\nstderr:\n${raw.stderr.slice(-2000)}`
    );
  }
}

function extractQuestion(result: string): string | null {
  const index = result.indexOf(NEEDS_INPUT_SENTINEL);
  if (index === -1) {
    return null;
  }
  const question = result.slice(index + NEEDS_INPUT_SENTINEL.length).trim();
  return question || "（Claude 请求确认，但未给出具体问题）";
}

// 激进版"无人值守"指令：把哨兵从"求助信号"翻转为"任务被判定 blocked"——让 Claude 倾向自己决策、
// 在 commit message 里留决策理由，而不是停下等人。仅 auto_reply=true 时使用。
function autoReplyDirective(task: Task): string[] {
  const hints = task.auto_decision_hints?.trim();
  return [
    "You run UNATTENDED. No human is watching. Make all decisions yourself and finish in one shot.",
    "",
    "Decision rules:",
    "- Choose the minimal change that satisfies the goal; prefer existing patterns over introducing new ones.",
    "- For style / scope / \"is this enough\" / \"should I also X\" questions — just decide. Document the choice in one line of the commit message body.",
    "- Run local verification (typecheck / build / lint) before finishing if a relevant script exists.",
    "- DO NOT stop for preferences, scope ambiguity, or to confirm progress.",
    ...(hints ? ["", "Decision policy from requester:", hints] : []),
    "",
    `Stopping protocol (LAST RESORT only): If you literally cannot proceed — missing credentials, a file the task assumes exists, two requirements directly contradict — end with ${NEEDS_INPUT_SENTINEL} + one-sentence reason. The system will CONCLUDE THE TASK AS BLOCKED.`
  ];
}

// 默认（auto_reply=false）的协作指令：邀请使用哨兵停下等人回复。
function manualReplyDirective(): string[] {
  return [
    `If you need a decision or clarification from the user before you can proceed safely, do NOT guess. End your reply with a line containing exactly ${NEEDS_INPUT_SENTINEL} followed by your question, then stop without making further changes. The user will reply and you will be resumed in this same session to continue.`
  ];
}

function replyDirective(task: Task): string[] {
  return task.auto_reply ? autoReplyDirective(task) : manualReplyDirective();
}

function taskPrompt(task: Task): string {
  return [
    `ClaudeCenter task: ${task.title}`,
    "",
    "Goal:",
    task.description,
    "",
    "Work directly in the current repository. Implement the requested code changes, keep edits scoped, and run the most relevant local verification command when possible.",
    "",
    ...replyDirective(task)
  ].join("\n");
}

function resumePrompt(task: Task, reply: string): string {
  return [
    "The user replied to your question:",
    "",
    reply,
    "",
    "Continue the ClaudeCenter task using this answer.",
    "",
    ...replyDirective(task)
  ].join("\n");
}

function rejectionPrompt(task: Task, feedback: string): string {
  return [
    "Your previous implementation was reviewed by the user and sent back for revision. Reviewer feedback:",
    "",
    feedback,
    "",
    "Revise the implementation on the current branch to address this feedback. Your changes will update the existing PR.",
    "",
    ...replyDirective(task)
  ].join("\n");
}

// 续接重试 prompt:failed 任务带上次失败原因(error_message);cancelled 任务无 error_message,
// 用「此前被中断」措辞。让 Claude 带着「上次为什么没成」在当前分支接着干。
function retryPrompt(task: Task): string {
  const head = task.error_message?.trim()
    ? ["Your previous run failed with this error:", "", task.error_message.trim(), "", "Fix the cause and complete the task on the current branch."]
    : ["Your previous run was interrupted before completing.", "", "Continue and complete the task on the current branch."];
  return [...head, "", ...replyDirective(task)].join("\n");
}

function prBody(task: Task, claudeOutput: string): string {
  return [
    `ClaudeCenter task: ${task.id}`,
    "",
    "## Request",
    task.description,
    "",
    "## Worker Evidence",
    "Claude Code finished locally. The PR was created by the assigned desktop Worker.",
    "",
    "## Claude Output",
    "```text",
    claudeOutput.slice(-6000),
    "```"
  ].join("\n");
}

function extractPrUrl(output: string): string | null {
  const match = output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  return match?.[0] ?? null;
}

// 处理一轮 Claude 输出：先记下续接所需 session；若请求确认则落评论 + 转入等待；
// 否则按 git 改动收尾（commit / push / PR）。
async function handleClaudeTurn(
  config: WorkerConfig,
  task: Task,
  localPath: string,
  wtPath: string,
  turn: ClaudeTurn
): Promise<void> {
  const pool = getPool();
  if (turn.sessionId) {
    await setTaskClaudeSession(pool, task.id, config.workerId, turn.sessionId);
  }

  const question = extractQuestion(turn.result);
  // 本轮 Claude 结束:细颗粒度时间线节点(逐轮对话富展示在「Claude Code 执行」Tab,这里只记里程碑)。
  await addTaskEvent(pool, task.id, config.workerId, "claude_turn_finished", question ? "本轮结束·请求确认" : "本轮执行结束", {
    hitSentinel: Boolean(question),
    resultPreview: turn.result.slice(0, 500)
  });
  if (question) {
    // 哨兵命中：先把问题落成 worker 评论（不论是否 auto_reply 都留审计）。
    await addTaskComment(pool, { taskId: task.id, author: "worker", workerId: config.workerId, body: question });

    // auto_reply 兜底分支：worktree 零改动 → 直接 fail（任务多半描述不全，再问也是同样结果）；
    // 有改动 → 自动塞一条 user 评论让现有 resumable 流续接，cap=AUTO_REPLY_MAX_ROUNDS。
    if (task.auto_reply) {
      const status = await runCommand("git", ["-C", wtPath, "status", "--porcelain"], { timeoutMs: 60_000 });
      const hasChanges = status.stdout.trim() !== "";
      if (!hasChanges) {
        await markTaskFailed(
          pool,
          task.id,
          config.workerId,
          `auto_reply: Claude requested input before making any changes. Question: ${question}`,
          { failedAt: new Date().toISOString(), autoReply: { reason: "no-changes", question } }
        );
        await addTaskEvent(pool, task.id, config.workerId, "auto_reply_blocked", "auto_reply: 零改动卡住 → 失败", { question });
        return;
      }
      const usedRounds = await countAutoReplyRounds(task.id);
      if (usedRounds >= AUTO_REPLY_MAX_ROUNDS) {
        await markTaskFailed(
          pool,
          task.id,
          config.workerId,
          `auto_reply: blocked after ${AUTO_REPLY_MAX_ROUNDS} auto-reply rounds. Last question: ${question}`,
          { failedAt: new Date().toISOString(), autoReply: { reason: "max-rounds", usedRounds, question } }
        );
        await addTaskEvent(pool, task.id, config.workerId, "auto_reply_blocked", `auto_reply: cap=${AUTO_REPLY_MAX_ROUNDS} 仍在问 → 失败`, { usedRounds, question });
        return;
      }
      const nextRound = usedRounds + 1;
      await addTaskComment(pool, { taskId: task.id, author: "user", workerId: null, body: AUTO_REPLY_CANNED });
      await addTaskEvent(
        pool,
        task.id,
        config.workerId,
        "auto_reply",
        `Auto-replied (round ${nextRound}/${AUTO_REPLY_MAX_ROUNDS})`,
        { round: nextRound, question, reply: AUTO_REPLY_CANNED }
      );
      await setTaskWaiting(pool, task.id, config.workerId, turn.sessionId);
      return;
    }

    // 默认（auto_reply=false）：等待用户回复期间，工作树原样保留（持有未提交改动），续接时复用。
    await setTaskWaiting(pool, task.id, config.workerId, turn.sessionId);
    await addTaskEvent(pool, task.id, config.workerId, "waiting", "Worker is waiting for user reply", { question });
    return;
  }

  await finalizeTask(config, task, localPath, wtPath, turn.result);
}

// 收尾：在任务专属工作树（wtPath）里检查/提交，并按 submit_mode 分流（PR 或直接推送目标分支）。
// localPath 是项目主仓，仅用于 push（push 模式落地即 merged）后移除工作树。
async function finalizeTask(
  config: WorkerConfig,
  task: Task,
  localPath: string,
  wtPath: string,
  claudeOutput: string
): Promise<void> {
  const pool = getPool();
  const status = await runCommand("git", ["-C", wtPath, "status", "--porcelain"], { timeoutMs: 60_000 });
  if (!status.stdout.trim()) {
    // 无改动也保留工作树：可能被打回重跑续接同一会话；进终态后由 GC 清理。
    await markTaskSuccess(
      pool,
      task.id,
      config.workerId,
      { workdir: wtPath, noChanges: true, claudeResult: claudeOutput },
      null
    );
    return;
  }

  await runCommand("git", ["-C", wtPath, "add", "--all"], { timeoutMs: 5 * 60_000 });
  // --no-verify：这是自动化打的机械包装提交，无法预知各目标仓库的 commit-msg / pre-commit
  // 钩子规则（如 husky + commitlint 的 conventional 校验会以 type-empty/subject-empty 拒掉本消息）。
  // 跳过本地钩子让提交对任意目标仓库都稳；产物质量由 Claude 的改动与 PR 评审保证。
  await runCommand("git", ["-C", wtPath, "commit", "--no-verify", "-m", `ClaudeCenter task: ${task.title}`], {
    timeoutMs: 5 * 60_000
  });
  await addTaskEvent(pool, task.id, config.workerId, "committed", "Changes committed on work branch", {
    workBranch: task.work_branch
  });
  if (task.submit_mode === "push") {
    // 直接把工作分支的提交推送到目标分支，不开 PR——落地即 merged（无需后续合并轮询/清理）。
    const push = await runCommand(
      "git",
      ["-C", wtPath, "push", "origin", `${task.work_branch}:${task.target_branch}`],
      { timeoutMs: 15 * 60_000 }
    );
    await addTaskEvent(pool, task.id, config.workerId, "pushed", "Pushed directly to target branch", {
      targetBranch: task.target_branch
    });
    await markTaskMerged(pool, task.id, config.workerId, {
      workdir: wtPath,
      submitMode: "push",
      targetBranch: task.target_branch,
      gitStatusBeforeCommit: status.stdout,
      claudeResult: claudeOutput,
      pushStdout: push.stdout,
      pushStderr: push.stderr
    });
    // push 模式落地即 merged（终态），工作树用完即拆。
    await removeWorktree(localPath, wtPath);
    return;
  }

  await runCommand("git", ["-C", wtPath, "push", "-u", "origin", task.work_branch], {
    timeoutMs: 15 * 60_000
  });
  await addTaskEvent(pool, task.id, config.workerId, "pushed", "Pushed work branch to origin", {
    workBranch: task.work_branch
  });

  // 打回重跑时 PR 已存在：push 已自动更新该 PR，跳过 `gh pr create`（否则非零退出会把
  // 任务误标 failed）。首轮 pr_url 为 null，正常建 PR。
  if (task.pr_url) {
    await markTaskSuccess(
      pool,
      task.id,
      config.workerId,
      { workdir: wtPath, gitStatusBeforeCommit: status.stdout, claudeResult: claudeOutput, prReused: true },
      task.pr_url
    );
    return;
  }

  const pr = await runCommand(
    config.ghCommand,
    [
      "pr",
      "create",
      "--base",
      task.target_branch,
      "--head",
      task.work_branch,
      "--title",
      task.title,
      "--body",
      prBody(task, claudeOutput)
    ],
    { cwd: wtPath, timeoutMs: 10 * 60_000 }
  );
  const prUrl = extractPrUrl(`${pr.stdout}\n${pr.stderr}`);
  await addTaskEvent(pool, task.id, config.workerId, "pr_created", "Pull request created", { prUrl });

  // 自动合并 PR（仅 auto_merge_pr 开启且拿到 PR URL 时）：创建后立即 gh pr merge --merge。
  // best-effort：合并失败不影响任务成功（PR 已建好，可人工合）；成败都落 task event。
  // 合并成功后，周期性 cleanupMergedTask 会侦测 MERGED 并完成分支清理与 merged 终态迁移。
  const autoMerge: { attempted: boolean; ok?: boolean; detail?: string } = { attempted: false };
  if (task.auto_merge_pr && prUrl) {
    autoMerge.attempted = true;
    try {
      const merge = await runCommand(config.ghCommand, ["pr", "merge", prUrl, "--merge"], {
        cwd: wtPath,
        timeoutMs: 10 * 60_000
      });
      autoMerge.ok = true;
      autoMerge.detail = merge.stdout.trim() || merge.stderr.trim();
      await addTaskEvent(pool, task.id, config.workerId, "auto_merged", "PR auto-merged via gh pr merge --merge", {
        prUrl
      });
    } catch (error) {
      autoMerge.ok = false;
      autoMerge.detail = error instanceof Error ? error.message : String(error);
      await addTaskEvent(pool, task.id, config.workerId, "auto_merge_failed", autoMerge.detail, { prUrl });
    }
  }

  await markTaskSuccess(
    pool,
    task.id,
    config.workerId,
    {
      workdir: wtPath,
      submitMode: "pr",
      gitStatusBeforeCommit: status.stdout,
      claudeResult: claudeOutput,
      prStdout: pr.stdout,
      prStderr: pr.stderr,
      autoMerge
    },
    prUrl
  );
}

// 新任务：建分支后跑第一轮 Claude。
export async function executeTask(config: WorkerConfig, task: Task, hooks?: ExecHooks): Promise<void> {
  const pool = getPool();
  await markTaskRunning(pool, task.id, config.workerId);

  let localPath: string | null = null;
  try {
    ensureClaudeAvailable(hooks);
    localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for task ${task.id}`);
    }

    // 真并发隔离：每任务一棵独立工作树（项目内 .claude/worktrees/），从 origin/<base> 起新工作分支，互不踩主仓与彼此。
    const wtPath = worktreePathFor(localPath, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, {
      workBranch: task.work_branch,
      baseRef: `origin/${task.base_branch}`,
      fresh: true
    });
    await addTaskEvent(pool, task.id, config.workerId, "worktree_prepared", "工作树就绪", {
      workBranch: task.work_branch,
      fresh: true
    });

    const turn = await runTaskClaude(config, task.id, {
      prompt: taskPrompt(task),
      cwd: wtPath,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    // 失败保留工作树:供「续接重试」精确恢复未提交改动(见 docs/spec/task-event-timeline-retry.md §4.3);
    // 不重试也不激活的残留树由 GC 在任务离开 failed/cancelled 后回收。
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
  }
}

// 续接：用户已回复，续接同一 Claude 会话继续执行。复用任务工作树（持有上一轮未提交改动）。
export async function resumeTask(config: WorkerConfig, task: Task, hooks?: ExecHooks): Promise<void> {
  const pool = getPool();

  let localPath: string | null = null;
  try {
    ensureClaudeAvailable(hooks);
    localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for task ${task.id}`);
    }
    if (!task.claude_session_id) {
      throw new Error(`Task ${task.id} has no claude_session_id to resume`);
    }

    const reply = await getPendingReply(pool, task.id);
    if (!reply) {
      // 理论上 claimNextResumableTask 已保证有新回复；这里兜底退回等待，避免空跑 Claude。
      await setTaskWaiting(pool, task.id, config.workerId, task.claude_session_id);
      return;
    }

    const wtPath = worktreePathFor(localPath, task.id);
    // 复用工作树；若已被清理（如曾 GC）则从 work_branch 重建。
    await ensureWorktree(localPath, wtPath, { workBranch: task.work_branch, fresh: false });
    await addTaskEvent(pool, task.id, config.workerId, "worktree_prepared", "工作树就绪", {
      workBranch: task.work_branch,
      fresh: false
    });
    await addTaskEvent(pool, task.id, config.workerId, "resumed", "用户回复，续接执行", {});
    const turn = await runTaskClaude(config, task.id, {
      prompt: resumePrompt(task, reply),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    // 失败保留工作树(供续接重试),不删树。
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
  }
}

// 打回重跑：用户验收不通过并填了打回意见。复用/重建任务工作树（不再切主仓分支），续接同一
// Claude 会话带着打回意见修订。finalizeTask 会因 pr_url 已存在跳过建 PR、复用原 PR。
export async function rerunRejectedTask(config: WorkerConfig, task: Task, hooks?: ExecHooks): Promise<void> {
  const pool = getPool();

  let localPath: string | null = null;
  try {
    ensureClaudeAvailable(hooks);
    localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for task ${task.id}`);
    }
    if (!task.claude_session_id) {
      throw new Error(`Task ${task.id} has no claude_session_id to rerun`);
    }

    const feedback = await getPendingReply(pool, task.id);
    if (!feedback) {
      throw new Error(`Task ${task.id} was rejected without feedback`);
    }

    const wtPath = worktreePathFor(localPath, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, { workBranch: task.work_branch, fresh: false });
    await addTaskEvent(pool, task.id, config.workerId, "worktree_prepared", "工作树就绪", {
      workBranch: task.work_branch,
      fresh: false
    });
    await addTaskEvent(pool, task.id, config.workerId, "rerun_started", "打回重跑，续接执行", {});

    const turn = await runTaskClaude(config, task.id, {
      prompt: rejectionPrompt(task, feedback),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    // 失败保留工作树(供续接重试),不删树。
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
  }
}

// 失败/取消续接重试：用户对 failed/cancelled 任务点「重试」(claimNextRetryableTask 已翻 running)。
// 失败/取消时保留了工作树,故默认复用(含未提交改动);仅当工作树确被 GC 清理且无会话可续时退化全新执行。
// - 有 claude_session_id:resume 同一会话 + retryPrompt(带失败原因/中断点),复用工作树。
// - 无 session(Claude 还没跑就失败/取消):从 origin/<base> 全新重建 + taskPrompt,等同初次。
export async function retryFailedTask(config: WorkerConfig, task: Task, hooks?: ExecHooks): Promise<void> {
  const pool = getPool();

  let localPath: string | null = null;
  try {
    ensureClaudeAvailable(hooks);
    localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for task ${task.id}`);
    }

    const resume = Boolean(task.claude_session_id);
    const wtPath = worktreePathFor(localPath, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(
      localPath,
      wtPath,
      resume
        ? { workBranch: task.work_branch, fresh: false }
        : { workBranch: task.work_branch, baseRef: `origin/${task.base_branch}`, fresh: true }
    );
    await addTaskEvent(pool, task.id, config.workerId, "worktree_prepared", "工作树就绪", {
      workBranch: task.work_branch,
      fresh: !resume
    });
    await addTaskEvent(pool, task.id, config.workerId, "retry_started", resume ? "续接重试（恢复会话）" : "续接重试（全新执行）", {
      resume
    });

    const turn = await runTaskClaude(config, task.id, {
      prompt: resume ? retryPrompt(task) : taskPrompt(task),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id ?? undefined,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
  }
}

// 容错执行：清理里「可能本就不存在」的删分支操作，失败只回报、不抛，避免挡住 merged 迁移。
async function runTolerant(args: string[]): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await runCommand("git", args, { timeoutMs: 5 * 60_000 });
    return { ok: true, detail: result.stdout.trim() || result.stderr.trim() };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

// periodic 清理（仅 PR 模式）：查 PR 是否已合并。已合并则把本地切回签出分支并更新、删本地/远端
// 工作分支、转 merged；未合并仅打时间戳参与下轮轮转。checkout/pull 出错兜底为打时间戳重试，不丢「已合并」。
export async function cleanupMergedTask(config: WorkerConfig, task: Task): Promise<void> {
  const pool = getPool();
  try {
    const localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath || !task.pr_url) {
      await setTaskMergeChecked(pool, task.id, config.workerId);
      return;
    }

    const view = await runCommand(config.ghCommand, ["pr", "view", task.pr_url, "--json", "state,mergedAt,url"], {
      cwd: localPath,
      timeoutMs: 60_000
    });
    const pr = JSON.parse(view.stdout) as { state?: string; mergedAt?: string | null };

    if (pr.state !== "MERGED") {
      await setTaskMergeChecked(pool, task.id, config.workerId);
      return;
    }

    // 已合并：先拆掉任务工作树（否则工作分支仍被 checkout，-D 删不掉），再把主仓拉新、删本地/远端工作分支。
    await removeWorktree(localPath, worktreePathFor(localPath, task.id));
    await runCommand("git", ["-C", localPath, "fetch", "origin", "--prune"], { timeoutMs: 10 * 60_000 });
    await runCommand("git", ["-C", localPath, "checkout", task.base_branch], { timeoutMs: 5 * 60_000 });
    await runCommand("git", ["-C", localPath, "pull", "--ff-only", "origin", task.base_branch], {
      timeoutMs: 10 * 60_000
    });
    // squash/rebase 合并时签出分支没有工作分支的提交，必须 -D 强删；远端可能已被 GitHub 自动删除。
    const localBranchDeleted = await runTolerant(["-C", localPath, "branch", "-D", task.work_branch]);
    const remoteBranchDeleted = await runTolerant(["-C", localPath, "push", "origin", "--delete", task.work_branch]);

    await markTaskMerged(pool, task.id, config.workerId, {
      mergedAt: pr.mergedAt ?? null,
      cleanedUpAt: new Date().toISOString(),
      localBranchDeleted,
      remoteBranchDeleted
    });
  } catch (error) {
    // PR 已合并但本地清理失败（如签出分支切换/拉取出错）：打时间戳退到轮转队尾，下轮重试，不丢「已合并」。
    await setTaskMergeChecked(pool, task.id, config.workerId);
    await addTaskEvent(
      pool,
      task.id,
      config.workerId,
      "cleanup_retry",
      error instanceof Error ? error.message : String(error),
      {}
    );
  }
}

function payloadText(command: DirectCommand): string {
  const value = command.payload.text;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Command payload.text is required");
  }
  return value;
}

function payloadCwd(command: DirectCommand): string | undefined {
  const value = command.payload.cwd;
  return typeof value === "string" && value.trim() ? value : undefined;
}

// 定向指令用文本模式调用 claude（仅 -p，无会话续接 / 安全姿态），与任务执行解耦；走同一终端配置。
function runClaude(config: WorkerConfig, prompt: string, cwd?: string): Promise<CommandResult> {
  return spawnClaude(config, { prompt, cwd, full: false });
}

// 定向 shell 指令：在 worker 配置的运行终端里执行（与 claude 同款终端形态）。前置命令先行，故其设置的
// 环境（代理 / VPN / 登录）被命令继承；命令文本按所选终端家族语法书写、内联进脚本（与前置命令同款约定）。
// 终端可执行文件 shell:false spawn（含空格全路径安全，脚本作单参不被二次解析）。空配置回退平台默认终端。
function runShellInTerminal(config: WorkerConfig, command: string, cwd?: string): Promise<CommandResult> {
  const terminalCommand = config.terminalCommand || defaultTerminalCommand();
  const family = shellFamily(terminalCommand);
  const script = buildTerminalScript(family, config.claudePreCommand, command);
  const launch = terminalLaunch(terminalCommand, script);
  return runCommand(launch.cmd, launch.args, {
    cwd,
    timeoutMs: SHELL_COMMAND_TIMEOUT_MS,
    shell: false
  });
}

export async function executeDirectCommand(config: WorkerConfig, command: DirectCommand): Promise<void> {
  const pool = getPool();
  await markDirectCommandRunning(pool, command.id, config.workerId);

  try {
    const text = payloadText(command);
    const cwd = payloadCwd(command);
    const result =
      command.command === "shell" ? await runShellInTerminal(config, text, cwd) : await runClaude(config, text, cwd);

    await markDirectCommandSuccess(pool, command.id, config.workerId, {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cwd
    });
  } catch (error) {
    await markDirectCommandFailed(pool, command.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
  }
}

// 实时对话一轮：在指定项目分支的「只读工作树」里跑 claude（非流式 json，与任务同 runClaudeJson），执行期间
// 周期 + 终态把 session .jsonl 同步到 conversation_sessions（Console 据此富展示）；收尾落最终全文 + session。
// 全程不 commit / 不开 PR（与任务流彻底解耦）。turn 是已认领的 assistant streaming 消息。
export async function executeConversationTurn(
  config: WorkerConfig,
  conv: Conversation,
  turn: ConversationMessage,
  hooks?: ExecHooks
): Promise<void> {
  const pool = getPool();
  try {
    ensureClaudeAvailable(hooks);
    const localPath = await getConversationLocalPath(pool, conv.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for conversation ${conv.id}`);
    }
    const prompt = await getConversationPrompt(pool, conv.id);
    if (!prompt) {
      throw new Error(`Conversation ${conv.id} has no pending user prompt`);
    }

    // 只读检出：每会话一棵 worktree（项目内 .claude/worktrees/），检出到 origin/<branch>。首轮新建，续轮复用；全程不 commit。
    const wtPath = conversationWorktreePathFor(localPath, conv.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, {
      workBranch: `cc-conv-${conv.id}`,
      baseRef: `origin/${conv.branch}`,
      fresh: !existsSync(path.join(wtPath, ".git"))
    });

    // 执行期间周期 + 终态把 session .jsonl 同步到 conversation_sessions；进程退出后强制最终同步一次保证完整。
    const stopSync = startConversationSessionSync(conv.id, wtPath);
    const { sessionId, result } = await runClaudeJson(config, {
      prompt,
      cwd: wtPath,
      resumeSessionId: conv.claude_session_id ?? undefined,
      model: conv.model,
      onSpawn: hooks?.onClaudeSpawn
    }).finally(() => stopSync());

    await finalizeConversationTurn(pool, { conversationId: conv.id, messageId: turn.id, body: result, sessionId });
  } catch (error) {
    await failConversationTurn(pool, { messageId: turn.id, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}
