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
import type { WorkerConfig } from "./config.js";
import { runCommand, runPowerShell, type CommandResult } from "./shell.js";
import { ensureWorktree, removeWorktree, worktreePathFor } from "./worktree.js";

const CLAUDE_TIMEOUT_MS = 60 * 60_000;

// Claude 在 headless 模式下没有内建「需要提问」信号，约定这个哨兵：需要用户确认时
// Claude 在回复末尾输出该串 + 问题后停止，Worker 解析后落为评论并等待回复。
const NEEDS_INPUT_SENTINEL = "<<CLAUDE_CENTER_NEEDS_INPUT>>";

type ClaudeTurn = { sessionId: string | null; result: string; raw: CommandResult };

// 运行 `claude -p <prompt> --output-format json`，可选 `--resume <session_id>` 续接已有
// 会话。统一附带任务执行的安全姿态：`--permission-mode bypassPermissions`（headless 自主跑、
// 不为权限停）+ `--settings`（deny 写类 git，交还 Worker）+ `--append-system-prompt-file`
// （中控协议规则）。配置了前置命令（代理 / VPN）时在同一 PowerShell 会话内先执行，使其设置
// 的环境变量被 claude 继承；prompt 与路径经环境变量传入，空格 / 引号 / 换行不被破坏。session
// id 是 UUID，无 shell 元字符，可安全内联进脚本。
function runClaudeJson(
  config: WorkerConfig,
  opts: { prompt: string; cwd?: string; resumeSessionId?: string }
): Promise<ClaudeTurn> {
  const run = config.claudePreCommand
    ? runPowerShell(
        // 路径经环境变量传入：PowerShell 在实参位展开 $env: 变量不做分词，含空格的路径仍是单个实参。
        `${config.claudePreCommand}; & $env:CLAUDE_CENTER_CLAUDE_CMD -p $env:CLAUDE_CENTER_PROMPT --permission-mode $env:CLAUDE_CENTER_PERMISSION_MODE --settings $env:CLAUDE_CENTER_SETTINGS_PATH --append-system-prompt-file $env:CLAUDE_CENTER_RULES_PATH --output-format json${
          opts.resumeSessionId ? ` --resume ${opts.resumeSessionId}` : ""
        }`,
        {
          cwd: opts.cwd,
          timeoutMs: CLAUDE_TIMEOUT_MS,
          env: {
            ...process.env,
            CLAUDE_CENTER_CLAUDE_CMD: config.claudeCommand,
            CLAUDE_CENTER_PROMPT: opts.prompt,
            CLAUDE_CENTER_PERMISSION_MODE: config.permissionMode,
            CLAUDE_CENTER_SETTINGS_PATH: config.claudeSettingsPath,
            CLAUDE_CENTER_RULES_PATH: config.claudeRulesPath
          }
        }
      )
    : runCommand(
        config.claudeCommand,
        [
          "-p",
          opts.prompt,
          ...(opts.resumeSessionId ? ["--resume", opts.resumeSessionId] : []),
          "--permission-mode",
          config.permissionMode,
          "--settings",
          config.claudeSettingsPath,
          "--append-system-prompt-file",
          config.claudeRulesPath,
          "--output-format",
          "json"
        ],
        { cwd: opts.cwd, timeoutMs: CLAUDE_TIMEOUT_MS }
      );

  return run.then((raw) => {
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

// 问答类任务：纯对话，只读地回答关于该项目的问题，不修改任何文件。整段回复会原样作为
// 一条评论展示给用户，所以直接写成对用户的回答即可（无哨兵、无 git 收尾）。
function qaPrompt(task: Task): string {
  return [
    `ClaudeCenter Q&A: ${task.title}`,
    "",
    "Question:",
    task.description,
    "",
    "Answer the user's question about this repository. You may read any files to ground your answer, but this is a read-only conversation: do NOT modify, create, or delete any files, and do NOT run git. Reply with the answer itself — it will be shown to the user verbatim as a comment."
  ].join("\n");
}

function qaResumePrompt(reply: string): string {
  return [
    "The user followed up:",
    "",
    reply,
    "",
    "Continue the conversation. Stay read-only (no file or git changes); reply with the answer itself."
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

// 问答类一轮：记下续接 session → 把回答落为 worker 评论 → 转入等待，让用户继续追问或
// 手动「结束对话」。问答不收尾 git，恒定「答完即等待」。
async function handleQaTurn(config: WorkerConfig, task: Task, turn: ClaudeTurn): Promise<void> {
  const pool = getPool();
  if (turn.sessionId) {
    await setTaskClaudeSession(pool, task.id, config.workerId, turn.sessionId);
  }

  const answer = turn.result.trim() || "（Claude 未返回内容）";
  await addTaskComment(pool, { taskId: task.id, author: "worker", workerId: config.workerId, body: answer });
  await setTaskWaiting(pool, task.id, config.workerId, turn.sessionId);
  await addTaskEvent(pool, task.id, config.workerId, "waiting", "Q&A answered, waiting for next message", {});
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
  if (task.submit_mode === "push") {
    // 直接把工作分支的提交推送到目标分支，不开 PR——落地即 merged（无需后续合并轮询/清理）。
    const push = await runCommand(
      "git",
      ["-C", wtPath, "push", "origin", `${task.work_branch}:${task.target_branch}`],
      { timeoutMs: 15 * 60_000 }
    );
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
      prStderr: pr.stderr
    },
    prUrl
  );
}

// 新任务：工作类建分支后跑第一轮 Claude；问答类跳过 git，只读对话。
export async function executeTask(config: WorkerConfig, task: Task): Promise<void> {
  const pool = getPool();
  await markTaskRunning(pool, task.id, config.workerId);

  let localPath: string | null = null;
  try {
    localPath = await getTaskLocalPath(pool, task.id, config.workerId);
    if (!localPath) {
      throw new Error(`No local path linked for task ${task.id}`);
    }

    if (task.task_type === "qa") {
      // 问答类只读对话，不改文件、不需工作树隔离，仍在主仓只读地回答。
      const turn = await runClaudeJson(config, { prompt: qaPrompt(task), cwd: localPath });
      await handleQaTurn(config, task, turn);
      return;
    }

    // 真并发隔离：每任务一棵独立工作树，从 origin/<base> 起新工作分支，互不踩主仓与彼此。
    const wtPath = worktreePathFor(config, task.id);
    await runCommand("git", ["-C", localPath, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
    await ensureWorktree(localPath, wtPath, {
      workBranch: task.work_branch,
      baseRef: `origin/${task.base_branch}`,
      fresh: true
    });

    const turn = await runClaudeJson(config, { prompt: taskPrompt(task), cwd: wtPath });
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
export async function resumeTask(config: WorkerConfig, task: Task): Promise<void> {
  const pool = getPool();

  let localPath: string | null = null;
  try {
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

    if (task.task_type === "qa") {
      const turn = await runClaudeJson(config, {
        prompt: qaResumePrompt(reply),
        cwd: localPath,
        resumeSessionId: task.claude_session_id
      });
      await handleQaTurn(config, task, turn);
      return;
    }

    const wtPath = worktreePathFor(config, task.id);
    // 复用工作树；若已被清理（如曾 GC）则从 work_branch 重建。
    await ensureWorktree(localPath, wtPath, { workBranch: task.work_branch, fresh: false });
    const turn = await runClaudeJson(config, {
      prompt: resumePrompt(reply),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id
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
export async function rerunRejectedTask(config: WorkerConfig, task: Task): Promise<void> {
  const pool = getPool();

  let localPath: string | null = null;
  try {
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
      resumeSessionId: task.claude_session_id
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

// 定向指令仍用文本模式调用 claude（无需会话续接），与任务执行解耦。
function runClaude(config: WorkerConfig, prompt: string, cwd?: string): Promise<CommandResult> {
  if (!config.claudePreCommand) {
    return runCommand(config.claudeCommand, ["-p", prompt], { cwd, timeoutMs: CLAUDE_TIMEOUT_MS });
  }

  const script = `${config.claudePreCommand}; & $env:CLAUDE_CENTER_CLAUDE_CMD -p $env:CLAUDE_CENTER_PROMPT`;
  return runPowerShell(script, {
    cwd,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    env: {
      ...process.env,
      CLAUDE_CENTER_CLAUDE_CMD: config.claudeCommand,
      CLAUDE_CENTER_PROMPT: prompt
    }
  });
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
