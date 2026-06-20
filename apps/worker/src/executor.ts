import {
  addTaskComment,
  addTaskEvent,
  failConversationTurn,
  finalizeConversationTurn,
  getAttachmentBlob,
  getConversationLocalPath,
  getConversationPrompt,
  getPendingReply,
  getPool,
  getTaskLocalPath,
  listAttachmentsForTask,
  listPendingReplyAttachments,
  listProjectRepos,
  listTaskRepos,
  markDirectCommandFailed,
  markDirectCommandRunning,
  markDirectCommandSuccess,
  markTaskFailed,
  markTaskRunning,
  markTaskSuccess,
  setConversationTurnProcess,
  setTaskClaudeSession,
  setTaskWaiting,
  updateTaskRepoPrUrl,
  updateTaskRepoRelativePath,
  updateTaskRepoStatus,
  type AttachmentMeta,
  type Conversation,
  type ConversationMessage,
  type DirectCommand,
  type Task,
  type TaskRepo
} from "@claude-center/db";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { getProcessStartTime, runCommand, type CommandResult } from "./shell.js";
import {
  buildClaudeScript,
  buildTerminalScript,
  CLAUDE_ENV,
  defaultTerminalCommand,
  isWsl,
  shellFamily,
  terminalLaunch
} from "./terminal.js";
import {
  assertSubRepoPathIgnoredInMain,
  conversationWorktreePathFor,
  ensureSubRepoCloned,
  ensureWorktree,
  resolveSubRepoRelativePath,
  worktreePathFor
} from "./worktree.js";
import { findSessionInfo, startConversationSessionSync, startTaskSessionSync } from "./session.js";

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

// 附件子目录：在主仓 worktree 根下创建 `.claude-attachments/`，用相对路径写进 prompt 让 Claude 读。
// 整目录随 worktree GC 一并销毁；不持久化（详见 docs/spec/task-attachments.md §Worker 流程）。
const ATTACHMENT_DIR_RELATIVE = ".claude-attachments";

// 文件名规则：`<sha256前8位>-<清洗过的原名>`，便于 sha256 跨轮判存（避免重复落盘）。
function attachmentFileName(meta: AttachmentMeta): string {
  const short = meta.sha256.slice(0, 8);
  const safe = meta.original_name.replace(/[\x00-\x1f\x7f\\/]/g, "_").slice(0, 200);
  return `${short}-${safe}`;
}

// 落盘所有附件到 worktree 内 `.claude-attachments/`。已存在同名（同 sha256）跳过 SELECT，省 PG IO。
// 注意：Worker 直连 PG，不走 Console HTTP——是「DB bytea」抉择的直接体现。
async function materializeAttachments(
  wtPath: string,
  attachments: AttachmentMeta[]
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }
  const dir = path.join(wtPath, ATTACHMENT_DIR_RELATIVE);
  mkdirSync(dir, { recursive: true });
  const pool = getPool();
  for (const meta of attachments) {
    const target = path.join(dir, attachmentFileName(meta));
    if (existsSync(target)) {
      continue;
    }
    const blob = await getAttachmentBlob(pool, meta.id);
    if (!blob) {
      // 附件可能已被删（task 级联删除窗口）；跳过且继续，不阻塞主流程。
      continue;
    }
    await writeFile(target, blob.data);
  }
}

// 任务原始附件（绑定到 task_id）。
async function loadTaskAttachments(taskId: string): Promise<AttachmentMeta[]> {
  return listAttachmentsForTask(getPool(), taskId);
}

// resume / rerun 路径用：本轮回复涉及的附件（聚合最后一条 worker 评论之后所有 user 评论的附件）。
async function loadReplyAttachments(taskId: string): Promise<AttachmentMeta[]> {
  return listPendingReplyAttachments(getPool(), taskId);
}

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
  // 任务级「动态工作流」开关：true 给 claude 注入 CLAUDE_CODE_WORKFLOWS=1 启用 Workflows 特性，
  // false 注入 CLAUDE_CODE_DISABLE_WORKFLOWS=1 关闭（见 workflowEnv）。缺省=关闭（对话/定向指令不传）。
  dynamicWorkflow?: boolean;
  onSpawn?: (child: ChildProcess) => void;
  // true=任务执行（带 --settings / --append-system-prompt-file / --permission-mode / --output-format json）；
  // false=定向 claude 指令（仅 `-p <prompt>`，跟随 claude 默认）。
  full: boolean;
  // true=detached 启动（stdio:ignore + unref）：worker 退出后 claude 不被杀、继续写 .jsonl。对话轮用，使「关机存活」成立。
  detached?: boolean;
};

// 「动态工作流」按任务开关映射到 claude 进程 env。ground truth（claude 2.1.x 二进制）：
//   启用 ← CLAUDE_CODE_WORKFLOWS 为真；禁用 ← CLAUDE_CODE_DISABLE_WORKFLOWS 为真（优先级高于启用）。
// 任务级开关作权威：开→只设启用变量，关→只设禁用变量。worker 机器默认不全局设这两个变量
// （不在 .env.example / config 里），故无需再清反向变量——一条清晰路径即可确定状态。
// undefined（对话轮 / 定向指令不带此开关）则不注入任何变量，沿用 claude 默认，不改动任务以外的行为。
function workflowEnv(dynamicWorkflow: boolean | undefined): Record<string, string> {
  if (dynamicWorkflow === undefined) return {};
  return dynamicWorkflow ? { CLAUDE_CODE_WORKFLOWS: "1" } : { CLAUDE_CODE_DISABLE_WORKFLOWS: "1" };
}

// 统一的 claude 调用：按运行终端配置选执行形态。
// - 直接形态（默认终端 + 无前置命令）：spawn(claude, argv)，无 shell 解析，最稳，等同旧行为。
// - 终端形态（配了前置命令 或 自定义终端）：在所选终端的一个会话里跑 `<前置命令> <sep> <claude 调用>`，
//   使前置命令（VPN/代理/登录）设置的环境被 claude 继承。prompt/路径/claude 路径经 env 传入并按终端
//   家族安全引用（空格/引号/换行不破坏）；model/session-id(UUID)/permission-mode/output-format 为
//   无 shell 元字符的安全字面量，内联。终端可执行文件 shell:false spawn（含空格全路径安全）。
function spawnClaude(config: WorkerConfig, opts: ClaudeCallOpts): Promise<CommandResult> {
  // 'default' / 空 表示不指定 --model；其余为白名单别名（opus/sonnet/haiku），可安全内联。
  const modelArg = opts.model && opts.model !== "default" ? opts.model : null;
  // 动态工作流通过 env 注入（非 CLI flag），直接 / 终端两形态共用。
  const wfEnv = workflowEnv(opts.dynamicWorkflow);
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
      onSpawn: opts.onSpawn,
      detached: opts.detached,
      // POSIX：让 claude 成新进程组组长，取消/超时时可整组杀掉它派生的 git/gh/npm/MCP/子代理
      //（Windows 走 taskkill /T 杀树，不需要）。detached 的对话轮已自带新组，置此无副作用。
      newProcessGroup: process.platform !== "win32",
      env: { ...process.env, ...wfEnv }
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
    [CLAUDE_ENV.RULES]: config.claudeRulesPath,
    ...wfEnv
  };
  // WSL 不继承 Windows 进程 env，需在 WSLENV 声明转发的变量名（冒号分隔）；动态工作流变量一并转发。
  if (isWsl(terminalCommand)) {
    const names = [CLAUDE_ENV.CMD, CLAUDE_ENV.PROMPT, CLAUDE_ENV.SETTINGS, CLAUDE_ENV.RULES, ...Object.keys(wfEnv)].join(":");
    env.WSLENV = process.env.WSLENV ? `${process.env.WSLENV}:${names}` : names;
  }

  const launch = terminalLaunch(terminalCommand, script);
  // shell:false：终端含空格全路径作 argv[0] 安全，且脚本作单参不被 cmd.exe 二次解析。
  return runCommand(launch.cmd, launch.args, {
    cwd: opts.cwd,
    timeoutMs: CLAUDE_TIMEOUT_MS,
    onSpawn: opts.onSpawn,
    shell: false,
    env,
    // POSIX：终端形态下让终端进程（bash/zsh…）成新进程组组长，取消时整组杀掉终端 + 其内的 claude 及派生进程。
    // 否则终端形态取消是「完全 no-op」（-pid ESRCH 回退只杀终端壳、claude 仍活）。
    newProcessGroup: process.platform !== "win32",
    detached: opts.detached
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
    dynamicWorkflow?: boolean;
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
    dynamicWorkflow?: boolean;
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

// 附件 prompt 段（spec docs/spec/task-attachments.md §Worker 流程 §prompt 注入）。
// Claude CLI 支持读本地图片/文件路径；prompt 末尾列出已落盘的相对路径即可。空数组时返回空段。
function attachmentSection(attachments: AttachmentMeta[]): string[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const lines = attachments.map((a) => {
    const fname = attachmentFileName(a);
    return `- ./${ATTACHMENT_DIR_RELATIVE}/${fname} (${a.mime}, ${fmtAttachSize(a.size_bytes)})`;
  });
  return [
    "",
    "Attached files (already saved locally in the working tree, read them as needed):",
    ...lines
  ];
}

function fmtAttachSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 把 Claude 钉死在任务 worktree 内。Claude 的 cwd 已是 wtPath,但它(及其派生的子代理)解析路径时容易
// 落到物理上作为祖先目录的主检出同名文件——worktree 嵌套在 <主仓>/.claude/worktrees/ 下(worktree.ts),
// 主仓根是 cwd 的祖先,宽搜索/绝对路径解析易命中主检出那份拷贝。曾因此空转 ~5min 读主检出才自纠
// (docs/spec/worktree-exec-observability.md §2)。显式声明唯一工作目录 + 禁止越界来兜住。
function worktreeAnchor(wtPath: string): string[] {
  return [
    `You are running inside a dedicated git worktree at: ${wtPath}`,
    "This worktree is your ONLY working directory. The surrounding/parent checkout is OFF-LIMITS: do NOT read, search, or edit any file outside this worktree.",
    "Even if a tool or sub-agent reports an absolute path pointing elsewhere (e.g. the parent checkout), re-resolve it under this worktree before reading or editing. Prefer paths relative to this directory.",
    ""
  ];
}

function taskPrompt(task: Task, attachments: AttachmentMeta[], wtPath: string): string {
  return [
    ...worktreeAnchor(wtPath),
    `ClaudeCenter task: ${task.title}`,
    "",
    "Goal:",
    task.description,
    "",
    "Work directly in this worktree. Implement the requested code changes, keep edits scoped, and run the most relevant local verification command when possible.",
    ...attachmentSection(attachments),
    "",
    ...replyDirective(task)
  ].join("\n");
}

function resumePrompt(task: Task, reply: string, attachments: AttachmentMeta[], wtPath: string): string {
  return [
    ...worktreeAnchor(wtPath),
    "The user replied to your question:",
    "",
    reply,
    "",
    "Continue the ClaudeCenter task using this answer.",
    ...attachmentSection(attachments),
    "",
    ...replyDirective(task)
  ].join("\n");
}

// 续接重试 prompt:failed 任务带上次失败原因(error_message);cancelled 任务无 error_message,
// 用「此前被中断」措辞。让 Claude 带着「上次为什么没成」在当前分支接着干。
function retryPrompt(task: Task, attachments: AttachmentMeta[], wtPath: string): string {
  const head = task.error_message?.trim()
    ? ["Your previous run failed with this error:", "", task.error_message.trim(), "", "Fix the cause and complete the task on the current branch."]
    : ["Your previous run was interrupted before completing.", "", "Continue and complete the task on the current branch."];
  return [...worktreeAnchor(wtPath), ...head, ...attachmentSection(attachments), "", ...replyDirective(task)].join("\n");
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

// ====== 多仓任务（docs/spec/task-multi-repo.md）======
// task_repos 是任务级仓快照；TaskRepoCtx 补充 project_repos.repo_url，给 worktree 准备阶段
// 的 `git clone` 用（子仓本地缺失时 clone）。
type TaskRepoCtx = TaskRepo & { repo_url: string };

// 任务相关仓快照清单：listTaskRepos + JOIN project_repos 得到 repo_url 映射。
async function loadTaskRepoCtxs(taskId: string, projectId: string): Promise<TaskRepoCtx[]> {
  const pool = getPool();
  const [taskRepos, projectRepos] = await Promise.all([
    listTaskRepos(pool, taskId),
    listProjectRepos(pool, projectId)
  ]);
  const urlByPid = new Map(projectRepos.map((p) => [p.id, p.repo_url]));
  return taskRepos.map((tr) => ({ ...tr, repo_url: urlByPid.get(tr.project_repo_id) ?? "" }));
}

// 单仓 worktree 路径：主仓走 worktreePathFor；子仓 = 主 worktree 内 relative_path（原位嫁接，
// 与主仓 .gitignore 忽略路径一致，让 Claude 在主 wtPath 看到子仓代码原相对位置）。
function repoWtFor(localPath: string, taskId: string, ctx: TaskRepoCtx): string {
  const wtRoot = worktreePathFor(localPath, taskId);
  return ctx.role === "main" ? wtRoot : path.join(wtRoot, ctx.relative_path);
}

// 单仓本地仓路径：主仓 = localPath；子仓 = localPath/relative_path（约定子仓物理上在主仓内）。
function repoLocalFor(localPath: string, ctx: TaskRepoCtx): string {
  return ctx.role === "main" ? localPath : path.join(localPath, ctx.relative_path);
}

// 单仓签出：fresh=true 从 origin/<base> 强制重置 work_branch；fresh=false 复用已有 worktree。
// 子仓首次见到时自动 clone（约定本地路径 = mainLocal/<relative_path>），并探测主仓 .gitignore 是否
// 忽略该路径——未忽略则抛错（主仓 worktree 已占该路径 → 子仓 worktree add 会冲突）。
//
// 子仓 relative_path 来源（docs/spec/project-repos-runtime-path.md）：
//   - 任务创建时由 console 写占位 `*-<projectRepoId>`（不同 worker 上路径可能不同，console 端不持有）
//   - 这里检测到占位 → 调 resolveSubRepoRelativePath 在本机派生 → UPDATE task_repos
//   - 派生后改写 ctx.relative_path，后续 worktree 嫁接 / commit / 事件标签逻辑不变
async function prepareRepoWorktree(
  localPath: string,
  taskId: string,
  ctx: TaskRepoCtx,
  fresh: boolean
): Promise<{ repoLocal: string; repoWt: string }> {
  if (ctx.role === "sub" && ctx.relative_path.startsWith("*-")) {
    if (!ctx.repo_url) {
      throw new Error(`子仓占位 ${ctx.relative_path} 缺 repo_url，无法派生本机路径（project_repos 配置不全？）`);
    }
    const resolved = await resolveSubRepoRelativePath(localPath, ctx.repo_url);
    await updateTaskRepoRelativePath(getPool(), ctx.id, resolved);
    ctx.relative_path = resolved;
  }

  const repoLocal = repoLocalFor(localPath, ctx);
  const repoWt = repoWtFor(localPath, taskId, ctx);

  if (ctx.role === "sub") {
    if (!ctx.repo_url) {
      throw new Error(`子仓 ${ctx.relative_path} 缺 repo_url，无法准备（project_repos 配置不全？）`);
    }
    await ensureSubRepoCloned(repoLocal, ctx.repo_url);
    await assertSubRepoPathIgnoredInMain(localPath, ctx.relative_path);
  }
  await runCommand("git", ["-C", repoLocal, "fetch", "origin"], { timeoutMs: 10 * 60_000 });
  await ensureWorktree(repoLocal, repoWt, {
    workBranch: ctx.work_branch,
    ...(fresh ? { baseRef: `origin/${ctx.base_branch}` } : {}),
    fresh
  });
  return { repoLocal, repoWt };
}

// 任务所有参与仓的 worktree 准备：跳过 sub_status='skipped' 的仓；每个仓发 worktree_prepared 事件。
async function prepareAllRepoWorktrees(
  task: Task,
  localPath: string,
  fresh: boolean,
  workerId: string
): Promise<TaskRepoCtx[]> {
  const pool = getPool();
  const ctxs = await loadTaskRepoCtxs(task.id, task.project_id);
  if (ctxs.length === 0) {
    throw new Error(`Task ${task.id} has no task_repos rows (multi-repo support requires at least the main row)`);
  }
  for (const ctx of ctxs) {
    if (ctx.sub_status === "skipped") {
      continue;
    }
    const { repoWt } = await prepareRepoWorktree(localPath, task.id, ctx, fresh);
    await addTaskEvent(pool, task.id, workerId, "worktree_prepared", `${ctx.role === "main" ? "主仓" : ctx.relative_path} 工作树就绪`, {
      repoRole: ctx.role,
      relativePath: ctx.relative_path,
      workBranch: ctx.work_branch,
      fresh
    });
    await primeRepoDeps(task.id, workerId, ctx, repoWt);
  }
  return ctxs;
}

// worktree 不继承主检出的 node_modules(gitignore)。有 package.json 且无 node_modules 时 best-effort 预装,
// 让 Claude 启动即有依赖,省掉它「执行中才发现缺依赖、现学现装」的空转(docs/spec/worktree-exec-observability.md §3)。
// 通用判定:不写死某项目的 setup 脚本(worker 跑任意项目)。失败不阻塞任务(Claude 仍可自行处理),
// 一律记 deps_primed 事件(outcome: installed/skipped-exists/skipped-no-pkg/failed)便于在时间线排查。
// resume/retry 复用 worktree 时 node_modules 多已在 → skipped-exists 自动跳过。
async function primeRepoDeps(taskId: string, workerId: string, ctx: TaskRepoCtx, repoWt: string): Promise<void> {
  const pool = getPool();
  const repoLabel = ctx.role === "main" ? "主仓" : ctx.relative_path;
  const ev = (outcome: string, msg: string, extra: Record<string, unknown> = {}) =>
    addTaskEvent(pool, taskId, workerId, "deps_primed", msg, { repoRole: ctx.role, relativePath: ctx.relative_path, outcome, ...extra });

  if (!existsSync(path.join(repoWt, "package.json"))) {
    await ev("skipped-no-pkg", `${repoLabel} 无 package.json，跳过依赖预热`);
    return;
  }
  if (existsSync(path.join(repoWt, "node_modules"))) {
    await ev("skipped-exists", `${repoLabel} node_modules 已存在，跳过依赖预热`);
    return;
  }
  try {
    // npm 在 Windows 是 npm.cmd → shell:true（CVE-2024-27980 后无 shell 拒绝 spawn .cmd）；windowsHide 由 runCommand 兜。
    const res = await runCommand("npm", ["install", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: repoWt,
      shell: true,
      timeoutMs: 10 * 60_000
    });
    await ev("installed", `${repoLabel} 依赖已预热（npm install）`, { exitCode: res.exitCode });
  } catch (error) {
    await ev("failed", `${repoLabel} 依赖预热失败（忽略，继续执行）`, {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500)
    });
  }
}

// 处理 Claude 输出：先记下续接所需 session；若请求确认则落评论 + 转入等待；否则按各仓 git 改动收尾。
// 「执行中随时留言、直接注入」（docs/spec/task-live-inject.md）：每轮无哨兵收尾前，先看本轮执行期间用户
// 有没有留言（task_comments 里有未消费的 user 评论），有则**不收尾、不进 waiting、不等下一次认领**——直接
// --resume 同一会话把留言注入续接，循环到某轮结束且确无新留言才收尾。onSpawn 把每轮 Claude 子进程句柄回
// 填给 runner，保证循环中途也能被取消杀到。ctxs 是各参与仓的快照（同工作树续接，无需重新准备）。
async function handleClaudeTurn(
  config: WorkerConfig,
  task: Task,
  localPath: string,
  wtPath: string,
  ctxs: TaskRepoCtx[],
  turn: ClaudeTurn,
  onSpawn?: (child: ChildProcess) => void
): Promise<void> {
  const pool = getPool();
  let current = turn;
  for (;;) {
    if (current.sessionId) {
      await setTaskClaudeSession(pool, task.id, config.workerId, current.sessionId);
    }

    const question = extractQuestion(current.result);
    // 本轮 Claude 结束:细颗粒度时间线节点(逐轮对话富展示在「Claude Code 执行」Tab,这里只记里程碑)。
    await addTaskEvent(pool, task.id, config.workerId, "claude_turn_finished", question ? "本轮结束·请求确认" : "本轮执行结束", {
      hitSentinel: Boolean(question),
      resultPreview: current.result.slice(0, 500)
    });
    if (question) {
      // 哨兵命中：先把问题落成 worker 评论（不论是否 auto_reply 都留审计）。
      await addTaskComment(pool, { taskId: task.id, author: "worker", workerId: config.workerId, body: question });

      // auto_reply 兜底分支：所有参与仓零改动 → 直接 fail（任务多半描述不全，再问也是同样结果）；
      // 任一仓有改动 → 自动塞一条 user 评论让现有 resumable 流续接，cap=AUTO_REPLY_MAX_ROUNDS。
      if (task.auto_reply) {
        const hasChanges = await anyRepoHasChanges(ctxs, localPath, task.id);
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
        await setTaskWaiting(pool, task.id, config.workerId, current.sessionId);
        return;
      }

      // 默认（auto_reply=false）：等待用户回复期间，工作树原样保留（持有未提交改动），续接时复用。
      await setTaskWaiting(pool, task.id, config.workerId, current.sessionId);
      await addTaskEvent(pool, task.id, config.workerId, "waiting", "Worker is waiting for user reply", { question });
      return;
    }

    // 无哨兵：收尾前先看本轮执行期间用户有没有留言；有则直接注入续接（同一会话、同一工作树），否则收尾。
    // 锚点（getPendingReply / listPendingReplyAttachments）= 上一次 resumed/rerun_started 之后的 user 评论；
    // 注入前补一条 resumed 推进锚点，保证同一批消息只消费一次、下一轮循环不重复注入。
    const reply = current.sessionId ? await getPendingReply(pool, task.id) : null;
    if (reply) {
      const replyAtts = await loadReplyAttachments(task.id);
      await materializeAttachments(wtPath, replyAtts);
      await addTaskEvent(pool, task.id, config.workerId, "resumed", "用户执行中留言，直接注入续接", { injected: true });
      current = await runTaskClaude(config, task.id, {
        prompt: resumePrompt(task, reply, replyAtts, wtPath),
        cwd: wtPath,
        resumeSessionId: current.sessionId ?? undefined,
        model: task.model,
        onSpawn
      });
      continue;
    }

    break;
  }

  await finalizeTaskMultiRepo(config, task, localPath, wtPath, ctxs, current.result);
}

// 多仓 helper：任一参与仓 git status 非空即返回 true（auto_reply 兜底判定用）。
async function anyRepoHasChanges(ctxs: TaskRepoCtx[], localPath: string, taskId: string): Promise<boolean> {
  for (const ctx of ctxs) {
    if (ctx.sub_status === "skipped") continue;
    const subWt = repoWtFor(localPath, taskId, ctx);
    const status = await runCommand("git", ["-C", subWt, "status", "--porcelain"], { timeoutMs: 60_000 });
    if (status.stdout.trim() !== "") return true;
  }
  return false;
}

// work_branch 是否领先 target_branch（持有未合并提交）。用于区分两种「工作区干净」：真无改动 vs
// 首轮已提交但 PR / push 未成、改动留在提交里。比较 origin/<target>..HEAD——worktree 与主仓共享 refs，
// prepare 阶段已 `git fetch origin`，origin/<target> 是最新值。取不到该 ref（目标分支尚不存在等）时
// rev-list 报错，保守返回 false（按真无改动处理，不误建空 PR）。
async function branchAheadOfTarget(subWt: string, targetBranch: string): Promise<boolean> {
  try {
    const res = await runCommand(
      "git",
      ["-C", subWt, "rev-list", "--count", `origin/${targetBranch}..HEAD`],
      { timeoutMs: 60_000 }
    );
    return Number.parseInt(res.stdout.trim(), 10) > 0;
  } catch {
    return false;
  }
}

// 查 work_branch → target_branch 的已开 PR（幂等建 PR 用）。无匹配 / 查询失败均返回 null，
// 交回上层正常走 gh pr create。
async function findExistingPrUrl(
  config: WorkerConfig,
  subWt: string,
  workBranch: string,
  targetBranch: string
): Promise<string | null> {
  try {
    const res = await runCommand(
      config.ghCommand,
      ["pr", "list", "--head", workBranch, "--base", targetBranch, "--state", "open", "--json", "url"],
      { cwd: subWt, timeoutMs: 60_000 }
    );
    const list = JSON.parse(res.stdout.trim() || "[]") as { url?: string }[];
    return list[0]?.url ?? null;
  } catch {
    return null;
  }
}

// 收尾：在任务专属工作树（wtPath）里检查/提交，并按 submit_mode 分流（PR 或直接推送目标分支）。
// localPath 是项目主仓，仅用于 push（push 模式落地即 merged）后移除工作树。
// 多仓 finalize（spec §7）：循环 task_repos 各自 commit/push/PR；强语义聚合（任一仓 failed → 任务整体 failed）。
// 单仓任务（task_repos 仅一行 main）→ 循环只跑 1 次，行为完全等价于改造前的 finalizeTask。
// 自动合并采用强一致策略：所有 PR 都 mergeable 才统一合，子仓先合 / 主仓最后合。
async function finalizeTaskMultiRepo(
  config: WorkerConfig,
  task: Task,
  localPath: string,
  wtPath: string,
  ctxs: TaskRepoCtx[],
  claudeOutput: string
): Promise<void> {
  const pool = getPool();

  // 按 role 排序：主仓最后处理，让 PR body 可以引用子仓 PR URL（事后回填见 P2）。
  // 提交顺序：子仓先 → 主仓后（强一致 auto_merge 时合并顺序也是子先主后）。
  const order = [...ctxs].sort((a, b) => {
    if (a.role === b.role) return a.relative_path.localeCompare(b.relative_path);
    return a.role === "sub" ? -1 : 1;
  });

  type RepoResult =
    | { ctx: TaskRepoCtx; sub: "no_changes" }
    | { ctx: TaskRepoCtx; sub: "pushed" }
    | { ctx: TaskRepoCtx; sub: "pr_created"; prUrl: string | null; reused: boolean }
    | { ctx: TaskRepoCtx; sub: "skipped" }
    | { ctx: TaskRepoCtx; sub: "failed"; error: string };

  const results: RepoResult[] = [];

  for (const ctx of order) {
    if (ctx.sub_status === "skipped") {
      results.push({ ctx, sub: "skipped" });
      continue;
    }
    const subWt = repoWtFor(localPath, task.id, ctx);
    const repoLabel = ctx.role === "main" ? "主仓" : ctx.relative_path;
    try {
      const status = await runCommand("git", ["-C", subWt, "status", "--porcelain"], { timeoutMs: 60_000 });
      const dirty = Boolean(status.stdout.trim());
      // 工作区干净 ≠ 一定无改动：首轮已 commit（甚至 push）却在建 PR / 推送前失败时，改动已落在
      // work_branch 的提交里、工作区是干净的。这种重试场景若当 no_changes 跳过，PR 永远建不出来
      // （曾踩：首轮失败→第二轮成功但 PR 未保存到任务）。故工作区干净时还要看 work_branch 是否领先
      // target_branch：领先说明有「已提交但未成 PR」的改动，仍要继续 push + 建 PR。
      if (!dirty && !(await branchAheadOfTarget(subWt, ctx.target_branch))) {
        await updateTaskRepoStatus(pool, ctx.id, "no_changes");
        await addTaskEvent(pool, task.id, config.workerId, "no_changes", `${repoLabel} 本轮无改动`, {
          repoRole: ctx.role,
          relativePath: ctx.relative_path
        });
        results.push({ ctx, sub: "no_changes" });
        continue;
      }
      if (dirty) {
        await runCommand("git", ["-C", subWt, "add", "--all"], { timeoutMs: 5 * 60_000 });
        // --no-verify：自动化机械提交，跳过目标仓库的 commit-msg / pre-commit 钩子（见原 finalizeTask 注释）。
        const commitMsg =
          ctx.role === "main" && order.filter((c) => c.sub_status !== "skipped").length === 1
            ? `ClaudeCenter task: ${task.title}`
            : `ClaudeCenter task: ${task.title} (${ctx.role === "main" ? "main" : ctx.relative_path})`;
        await runCommand("git", ["-C", subWt, "commit", "--no-verify", "-m", commitMsg], { timeoutMs: 5 * 60_000 });
        await updateTaskRepoStatus(pool, ctx.id, "committed");
        await addTaskEvent(pool, task.id, config.workerId, "committed", `${repoLabel} 已提交`, {
          repoRole: ctx.role,
          relativePath: ctx.relative_path,
          workBranch: ctx.work_branch
        });
      } else {
        // 工作区干净但 work_branch 领先：复用上一轮已落的提交，无需再 commit，直接走 push + 建 PR。
        await addTaskEvent(pool, task.id, config.workerId, "committed", `${repoLabel} 复用上一轮已提交改动`, {
          repoRole: ctx.role,
          relativePath: ctx.relative_path,
          workBranch: ctx.work_branch,
          reusedCommit: true
        });
      }

      if (task.submit_mode === "push") {
        const push = await runCommand(
          "git",
          ["-C", subWt, "push", "origin", `${ctx.work_branch}:${ctx.target_branch}`],
          { timeoutMs: 15 * 60_000 }
        );
        await updateTaskRepoStatus(pool, ctx.id, "pushed");
        await addTaskEvent(pool, task.id, config.workerId, "pushed", `${repoLabel} 已直推目标分支`, {
          repoRole: ctx.role,
          relativePath: ctx.relative_path,
          targetBranch: ctx.target_branch,
          pushStdout: push.stdout.slice(0, 1000)
        });
        results.push({ ctx, sub: "pushed" });
        continue;
      }

      await runCommand("git", ["-C", subWt, "push", "-u", "origin", ctx.work_branch], { timeoutMs: 15 * 60_000 });
      await addTaskEvent(pool, task.id, config.workerId, "pushed", `${repoLabel} 工作分支已推送`, {
        repoRole: ctx.role,
        relativePath: ctx.relative_path,
        workBranch: ctx.work_branch
      });

      // 打回重跑时该仓的 PR 已存在：push 已自动更新；跳过 gh pr create（与原 finalize 同理）。
      if (ctx.pr_url) {
        await updateTaskRepoStatus(pool, ctx.id, "pr_created");
        results.push({ ctx, sub: "pr_created", prUrl: ctx.pr_url, reused: true });
        continue;
      }

      // 幂等建 PR：首轮可能已 `gh pr create` 成功、却在落 pr_url 前失败（task_repos.pr_url 仍空）。
      // 此时再 create 会因「a pull request already exists」整仓判失败。先查同 head/base 的已开 PR，命中即复用。
      const existingPrUrl = await findExistingPrUrl(config, subWt, ctx.work_branch, ctx.target_branch);
      if (existingPrUrl) {
        await updateTaskRepoPrUrl(pool, ctx.id, existingPrUrl);
        await updateTaskRepoStatus(pool, ctx.id, "pr_created");
        await addTaskEvent(pool, task.id, config.workerId, "pr_created", `${repoLabel} 复用已存在 PR`, {
          repoRole: ctx.role,
          relativePath: ctx.relative_path,
          prUrl: existingPrUrl,
          reused: true
        });
        results.push({ ctx, sub: "pr_created", prUrl: existingPrUrl, reused: true });
        continue;
      }

      const pr = await runCommand(
        config.ghCommand,
        [
          "pr",
          "create",
          "--base",
          ctx.target_branch,
          "--head",
          ctx.work_branch,
          "--title",
          multiRepoPrTitle(task, ctx, order),
          "--body",
          prBody(task, claudeOutput)
        ],
        { cwd: subWt, timeoutMs: 10 * 60_000 }
      );
      const prUrl = extractPrUrl(`${pr.stdout}\n${pr.stderr}`);
      if (prUrl) {
        await updateTaskRepoPrUrl(pool, ctx.id, prUrl);
      }
      await updateTaskRepoStatus(pool, ctx.id, "pr_created");
      await addTaskEvent(pool, task.id, config.workerId, "pr_created", `${repoLabel} PR 已建`, {
        repoRole: ctx.role,
        relativePath: ctx.relative_path,
        prUrl
      });
      results.push({ ctx, sub: "pr_created", prUrl, reused: false });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await updateTaskRepoStatus(pool, ctx.id, "failed", msg);
      await addTaskEvent(pool, task.id, config.workerId, "repo_failed", `${repoLabel} 失败`, {
        repoRole: ctx.role,
        relativePath: ctx.relative_path,
        error: msg.slice(0, 1000)
      });
      results.push({ ctx, sub: "failed", error: msg });
    }
  }

  // 强语义聚合：任一仓失败 → 任务整体 failed（已成功仓的 task_repos.sub_status 已落库便于排查）。
  const failures = results.filter((r) => r.sub === "failed");
  if (failures.length > 0) {
    const summary = failures
      .map((f) => `${f.ctx.role === "main" ? "主仓" : f.ctx.relative_path}: ${(f as { error: string }).error}`)
      .join("\n");
    await markTaskFailed(pool, task.id, config.workerId, summary, {
      workdir: wtPath,
      failedAt: new Date().toISOString(),
      multiRepo: results.map(serializeRepoResult)
    });
    return;
  }

  // 主仓结果用于 tasks.pr_url 镜像（向后兼容 Console 单 PR 列表 / 老链接）
  const mainResult = results.find((r) => r.ctx.role === "main");
  const mainPrUrl =
    mainResult && mainResult.sub === "pr_created" ? mainResult.prUrl : null;

  if (task.submit_mode === "push") {
    // submit_mode='push':所有参与仓 push 完即 success(终态,无 PR 可合)。
    // 「不再清理 worktree」(spec drop-accepted-rejected.md):保留 worktree 供用户本地复用,
    // 由 GC 兜底回收(GC keep 列表已含 success,真孤儿才被清)。
    await markTaskSuccess(
      pool,
      task.id,
      config.workerId,
      {
        workdir: wtPath,
        submitMode: "push",
        claudeResult: claudeOutput,
        multiRepo: results.map(serializeRepoResult)
      },
      null
    );
    return;
  }

  // submit_mode='pr':标记 success(Console 30s 轮询若检测到 PR 合并会自动翻 merged),保留所有 worktree。
  await markTaskSuccess(
    pool,
    task.id,
    config.workerId,
    {
      workdir: wtPath,
      submitMode: "pr",
      claudeResult: claudeOutput,
      multiRepo: results.map(serializeRepoResult)
    },
    mainPrUrl
  );

  // 强一致自动合并（spec 抉择 2）：所有 PR 都 mergeable 才统一合，否则全不合 + 告警事件。
  // 顺序：子仓先合、主仓最后（主仓往往引用子仓改动，反向合并 CI 易撞）。
  if (task.auto_merge_pr) {
    const prResults = results.filter(
      (r): r is { ctx: TaskRepoCtx; sub: "pr_created"; prUrl: string | null; reused: boolean } =>
        r.sub === "pr_created" && Boolean(r.prUrl)
    );
    if (prResults.length > 0) {
      await tryAutoMergeAllOrNone(config, task, prResults);
    }
  }
}

// 多仓 PR 标题：单仓时返回 task.title（与单仓行为一致）；多仓时加 `[main]` / `[<rel>]` 后缀
// 让 reviewer 一眼分辨这是同一任务跨仓 N 个 PR 之一。
function multiRepoPrTitle(task: Task, ctx: TaskRepoCtx, allCtxs: TaskRepoCtx[]): string {
  const active = allCtxs.filter((c) => c.sub_status !== "skipped");
  if (active.length <= 1) return task.title;
  return `${task.title} [${ctx.role === "main" ? "main" : ctx.relative_path}]`;
}

function serializeRepoResult(r: {
  ctx: TaskRepoCtx;
  sub: string;
  prUrl?: string | null;
  reused?: boolean;
  error?: string;
}): Record<string, unknown> {
  return {
    relativePath: r.ctx.relative_path,
    role: r.ctx.role,
    workBranch: r.ctx.work_branch,
    targetBranch: r.ctx.target_branch,
    sub: r.sub,
    ...(r.prUrl !== undefined ? { prUrl: r.prUrl } : {}),
    ...(r.reused !== undefined ? { reused: r.reused } : {}),
    ...(r.error !== undefined ? { error: r.error.slice(0, 2000) } : {})
  };
}

// 强一致自动合并：先批量 `gh pr view --json mergeable,mergeStateStatus` 检查全部 PR；
// 全部 MERGEABLE + CLEAN 才统一合，任一不可合 → 全不合 + 'auto_merge_skipped' 事件。
async function tryAutoMergeAllOrNone(
  config: WorkerConfig,
  task: Task,
  prResults: { ctx: TaskRepoCtx; prUrl: string | null }[]
): Promise<void> {
  const pool = getPool();
  type Check = { r: { ctx: TaskRepoCtx; prUrl: string | null }; ok: boolean; detail: string };
  const checks: Check[] = [];
  for (const r of prResults) {
    if (!r.prUrl) {
      checks.push({ r, ok: false, detail: "missing prUrl" });
      continue;
    }
    try {
      const view = await runCommand(
        config.ghCommand,
        ["pr", "view", r.prUrl, "--json", "mergeable,mergeStateStatus"],
        { timeoutMs: 60_000 }
      );
      const json = JSON.parse(view.stdout) as { mergeable?: string; mergeStateStatus?: string };
      const ok = json.mergeable === "MERGEABLE" && json.mergeStateStatus === "CLEAN";
      checks.push({ r, ok, detail: `mergeable=${json.mergeable} state=${json.mergeStateStatus}` });
    } catch (error) {
      checks.push({ r, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const notMergeable = checks.filter((c) => !c.ok);
  if (notMergeable.length > 0) {
    await addTaskEvent(
      pool,
      task.id,
      config.workerId,
      "auto_merge_skipped",
      `${notMergeable.length}/${checks.length} 个 PR 不可合并，按强一致策略全部跳过自动合并`,
      {
        notMergeable: notMergeable.map((c) => ({
          relativePath: c.r.ctx.relative_path,
          prUrl: c.r.prUrl,
          detail: c.detail
        }))
      }
    );
    return;
  }

  // 子仓先合 / 主仓最后（prResults 已按 finalize 顺序：子先 / 主后）
  for (const r of prResults) {
    if (!r.prUrl) continue;
    const repoLabel = r.ctx.role === "main" ? "主仓" : r.ctx.relative_path;
    try {
      await runCommand(config.ghCommand, ["pr", "merge", r.prUrl, "--merge"], { timeoutMs: 10 * 60_000 });
      await updateTaskRepoStatus(pool, r.ctx.id, "pr_merged");
      await addTaskEvent(pool, task.id, config.workerId, "auto_merged", `${repoLabel} PR 已自动合并`, {
        repoRole: r.ctx.role,
        relativePath: r.ctx.relative_path,
        prUrl: r.prUrl
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await addTaskEvent(pool, task.id, config.workerId, "auto_merge_failed", `${repoLabel}: ${detail.slice(0, 500)}`, {
        repoRole: r.ctx.role,
        relativePath: r.ctx.relative_path,
        prUrl: r.prUrl
      });
      // 已合的仓不回滚（GitHub 不可逆）；任务整体保留 success 等人工处理后续仓
      return;
    }
  }
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

    // 多仓任务支持（spec §6）：循环 task_repos 各自签出 worktree。主仓 wtPath 是 Claude cwd；
    // 子仓 worktree 原位嫁接到主 wtPath 内对应子目录，Claude 自然看到全部代码。
    // 单仓项目仅一行主仓 → 行为等价于改造前。
    const wtPath = worktreePathFor(localPath, task.id);
    const ctxs = await prepareAllRepoWorktrees(task, localPath, true, config.workerId);

    // 附件落盘（spec docs/spec/task-attachments.md §Worker 流程）：写到 wtPath/.claude-attachments/，
    // prompt 末尾列相对路径让 Claude 读。
    const taskAtts = await loadTaskAttachments(task.id);
    await materializeAttachments(wtPath, taskAtts);

    const turn = await runTaskClaude(config, task.id, {
      prompt: taskPrompt(task, taskAtts, wtPath),
      cwd: wtPath,
      model: task.model,
      dynamicWorkflow: task.dynamic_workflow,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, ctxs, turn, hooks?.onClaudeSpawn);
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
    // 多仓续接：所有参与仓的 worktree 各自复用（被 GC 清理过则按 work_branch 重建）。
    const ctxs = await prepareAllRepoWorktrees(task, localPath, false, config.workerId);
    // 落本轮回复的附件（已存在同 sha256 跳过）；任务原始附件可能在初轮已落但 GC 后会丢，所以一并补落。
    const replyAtts = await loadReplyAttachments(task.id);
    const taskAtts = await loadTaskAttachments(task.id);
    await materializeAttachments(wtPath, [...taskAtts, ...replyAtts]);
    await addTaskEvent(pool, task.id, config.workerId, "resumed", "用户回复，续接执行", {});
    const turn = await runTaskClaude(config, task.id, {
      prompt: resumePrompt(task, reply, replyAtts, wtPath),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id,
      model: task.model,
      dynamicWorkflow: task.dynamic_workflow,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, ctxs, turn, hooks?.onClaudeSpawn);
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
    // 多仓重试：有 session 复用所有仓 worktree；无 session 所有仓 fresh:true 重建。
    const ctxs = await prepareAllRepoWorktrees(task, localPath, !resume, config.workerId);
    // 重试一律重落任务原始附件（无论 resume / fresh）；fresh 时 worktree 全新没附件，resume 时也补落兜底。
    const taskAtts = await loadTaskAttachments(task.id);
    await materializeAttachments(wtPath, taskAtts);
    await addTaskEvent(pool, task.id, config.workerId, "retry_started", resume ? "续接重试（恢复会话）" : "续接重试（全新执行）", {
      resume
    });

    const turn = await runTaskClaude(config, task.id, {
      prompt: resume ? retryPrompt(task, taskAtts, wtPath) : taskPrompt(task, taskAtts, wtPath),
      cwd: wtPath,
      resumeSessionId: task.claude_session_id ?? undefined,
      model: task.model,
      dynamicWorkflow: task.dynamic_workflow,
      onSpawn: hooks?.onClaudeSpawn
    });
    await handleClaudeTurn(config, task, localPath, wtPath, ctxs, turn, hooks?.onClaudeSpawn);
  } catch (error) {
    await markTaskFailed(pool, task.id, config.workerId, error instanceof Error ? error.message : String(error), {
      failedAt: new Date().toISOString()
    });
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

// 从 session .jsonl 取末条 assistant 的文本（detached/重连下 claude 的 stdout 已不可得，终态结果只能从这里重建）。
function extractFinalAssistantText(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: { type?: string; message?: { content?: unknown } };
    try {
      obj = JSON.parse(trimmed) as { type?: string; message?: { content?: unknown } };
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message) continue;
    const content = obj.message.content;
    let cur = "";
    if (typeof content === "string") {
      cur = content;
    } else if (Array.isArray(content)) {
      cur = (content as Array<{ type?: string; text?: unknown }>)
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");
    }
    if (cur.trim()) text = cur; // 留住最后一条有正文的 assistant 轮
  }
  return text;
}

// 从 session .jsonl 收尾对话轮：result=末条 assistant 文本、sessionId=文件名。jsonl 缺失或无完整 assistant
// 回答（claude 中途崩）→ 返回 false（调用方据此 fail）；成功落 done 返回 true。finalizeConversationTurn 自带
// 终态守卫，不会覆盖已 cancelled 的轮。供正常收尾与「重启重连后进程已退」两条路径共用。
export async function finalizeConversationFromSession(
  pool: ReturnType<typeof getPool>,
  input: { conversationId: string; messageId: string; cwd: string }
): Promise<boolean> {
  const info = await findSessionInfo(input.cwd);
  if (!info) return false;
  const result = extractFinalAssistantText(info.jsonl);
  if (!result.trim()) return false;
  await finalizeConversationTurn(pool, {
    conversationId: input.conversationId,
    messageId: input.messageId,
    body: result,
    sessionId: info.sessionId
  });
  return true;
}

// 实时对话一轮：在指定项目分支的「只读工作树」里跑 claude，执行期间周期 + 终态把 session .jsonl 同步到
// conversation_sessions（Console 据此富展示）。claude 以 detached 启动（关机存活）、spawn 后立即持久化 pid+cwd
// 供 worker 重启重连；收尾一律从 .jsonl 重建（stdio 已 ignore）。全程不 commit / 不开 PR。turn 是已认领的 streaming 轮。
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
    let exitOk = false;
    try {
      // detached 启动：worker 关机后 claude 继续跑完、写 .jsonl。spawn 后立即把 pid+cwd 落到本轮，供重启重连判活。
      await spawnClaude(config, {
        prompt,
        cwd: wtPath,
        resumeSessionId: conv.claude_session_id ?? undefined,
        model: conv.model,
        full: true,
        detached: true,
        onSpawn: (child) => {
          hooks?.onClaudeSpawn?.(child);
          const pid = child.pid;
          if (pid) {
            // 记 pid + worktree cwd + 进程创建时间（身份校验防 pid 复用）。创建时间异步取，取不到存 null
            //（重启时无法校验身份 → 不重连，从 session 收尾）。
            void getProcessStartTime(pid)
              .then((startedAt) => setConversationTurnProcess(pool, turn.id, pid, wtPath, startedAt))
              .catch(() => {});
          }
        }
      });
      exitOk = true; // runCommand 非零退出/超时会 reject，走不到这里
    } catch {
      // 非零退出 / 超时 / 被取消杀死 → 下面按未成功收尾（fail，终态守卫保护已 cancelled 的轮）
    } finally {
      await stopSync(); // 终态强制最终同步，保证 .jsonl 完整入库
    }

    const finalized = exitOk && (await finalizeConversationFromSession(pool, { conversationId: conv.id, messageId: turn.id, cwd: wtPath }));
    if (!finalized) {
      await failConversationTurn(pool, { messageId: turn.id, errorMessage: "claude 未正常完成本轮（进程异常退出或无完整结果）" });
    }
  } catch (error) {
    await failConversationTurn(pool, { messageId: turn.id, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}
