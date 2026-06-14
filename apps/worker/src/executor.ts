import {
  addTaskComment,
  addTaskEvent,
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
  type DirectCommand,
  type Task
} from "@claude-center/db";
import type { ChildProcess } from "node:child_process";
import type { WorkerConfig } from "./config.js";
import { runCommand, runPowerShell, type CommandResult } from "./shell.js";
import {
  buildClaudeScript,
  CLAUDE_ENV,
  defaultTerminalCommand,
  isWsl,
  shellFamily,
  terminalLaunch
} from "./terminal.js";
import { ensureWorktree, removeWorktree, worktreePathFor } from "./worktree.js";

const CLAUDE_TIMEOUT_MS = 60 * 60_000;

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

function taskPrompt(task: Task): string {
  return [
    `ClaudeCenter task: ${task.title}`,
    "",
    "Goal:",
    task.description,
    "",
    "Work directly in the current repository. Implement the requested code changes, keep edits scoped, and run the most relevant local verification command when possible.",
    "",
    `If you need a decision or clarification from the user before you can proceed safely, do NOT guess. End your reply with a line containing exactly ${NEEDS_INPUT_SENTINEL} followed by your question, then stop without making further changes. The user will reply and you will be resumed in this same session to continue.`
  ].join("\n");
}

function resumePrompt(reply: string): string {
  return [
    "The user replied to your question:",
    "",
    reply,
    "",
    `Continue the ClaudeCenter task using this answer. If you still need another decision, use the same ${NEEDS_INPUT_SENTINEL} convention again; otherwise finish the implementation.`
  ].join("\n");
}

function rejectionPrompt(feedback: string): string {
  return [
    "Your previous implementation was reviewed by the user and sent back for revision. Reviewer feedback:",
    "",
    feedback,
    "",
    `Revise the implementation on the current branch to address this feedback. Your changes will update the existing PR. If you need a decision before proceeding, use the same ${NEEDS_INPUT_SENTINEL} convention; otherwise finish the revision.`
  ].join("\n");
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
  if (question) {
    // 等待用户回复期间，工作树原样保留（持有未提交改动），续接时复用。
    await addTaskComment(pool, { taskId: task.id, author: "worker", workerId: config.workerId, body: question });
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
  await runCommand("git", ["-C", wtPath, "commit", "-m", `ClaudeCenter task: ${task.title}`], {
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

    // 真并发隔离：每任务一棵独立工作树，从 origin/<base> 起新工作分支，互不踩主仓与彼此。
    const wtPath = worktreePathFor(config, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, {
      workBranch: task.work_branch,
      baseRef: `origin/${task.base_branch}`,
      fresh: true
    });

    const turn = await runClaudeJson(config, {
      prompt: taskPrompt(task),
      cwd: wtPath,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
    if (localPath) {
      await removeWorktree(localPath, worktreePathFor(config, task.id));
    }
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

    const wtPath = worktreePathFor(config, task.id);
    // 复用工作树；若已被清理（如曾 GC）则从 work_branch 重建。
    await ensureWorktree(localPath, wtPath, { workBranch: task.work_branch, fresh: false });
    const turn = await runClaudeJson(config, {
      prompt: resumePrompt(reply),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
    if (localPath) {
      await removeWorktree(localPath, worktreePathFor(config, task.id));
    }
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

    const wtPath = worktreePathFor(config, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, { workBranch: task.work_branch, fresh: false });

    const turn = await runClaudeJson(config, {
      prompt: rejectionPrompt(feedback),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id,
      model: task.model,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, turn);
  } catch (error) {
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
    if (localPath) {
      await removeWorktree(localPath, worktreePathFor(config, task.id));
    }
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
    await removeWorktree(localPath, worktreePathFor(config, task.id));
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

export async function executeDirectCommand(config: WorkerConfig, command: DirectCommand): Promise<void> {
  const pool = getPool();
  await markDirectCommandRunning(pool, command.id, config.workerId);

  try {
    const text = payloadText(command);
    const cwd = payloadCwd(command);
    const result =
      command.command === "shell" ? await runPowerShell(text, { cwd }) : await runClaude(config, text, cwd);

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
