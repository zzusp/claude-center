import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCommand } from "./shell.js";

// 真并发执行的工作树隔离：每个工作类任务一棵独立 git worktree，互不踩工作树（含同项目并发）。
// 主仓（localPath）只用于 fetch 与 worktree 管理，不被切到工作分支，全程保持稳定。
//
// 工作树建在项目主仓内 <localPath>/.claude/worktrees/ 下（与 Claude Code 原生 .claude/worktrees/
// 约定一致），而非全局数据目录——这样 cwd 落在项目路径前缀下，Claude Code 的 session transcript
// 记录在 ~/.claude/projects/<项目前缀>--claude-worktrees-worktree-<id>/，紧邻项目普通 session。
// git 会跳过已注册的 linked worktree 目录，主仓 status 不被弄脏。

const TASK_WT_PREFIX = "worktree-";
const CONV_WT_PREFIX = "worktree-conv-";
// 任务/会话 id 是 UUID；用它把「本 worker 管理的工作树」与同目录下 Claude Code dev 工作树（名为
// 人类 slug）区分开，避免 GC 误删用户在用的 dev 树。
const TASK_WT_RE = /^worktree-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function worktreesRoot(localPath: string): string {
  return path.join(localPath, ".claude", "worktrees");
}

export function worktreePathFor(localPath: string, taskId: string): string {
  return path.join(worktreesRoot(localPath), `${TASK_WT_PREFIX}${taskId}`);
}

// 实时对话的只读工作树：每会话一棵，检出到 origin/<branch>，全程不 commit。conv- 段与任务树区分。
export function conversationWorktreePathFor(localPath: string, conversationId: string): string {
  return path.join(worktreesRoot(localPath), `${CONV_WT_PREFIX}${conversationId}`);
}

// 让主仓忽略我们的工作树根（<localPath>/.claude/worktrees/），避免 git status 把它报成未跟踪而弄脏主仓。
// 写主仓本地 .git/info/exclude（不改动被跟踪的 .gitignore；多数项目已在 .gitignore 忽略，这里兜底覆盖未忽略的项目）。
// best-effort：失败不阻断任务。
function ensureWorktreesIgnored(localPath: string): void {
  try {
    const gitDir = path.join(localPath, ".git");
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
      return; // .git 为文件（localPath 本身是工作树）等异常情形不处理
    }
    const infoDir = path.join(gitDir, "info");
    const excludeFile = path.join(infoDir, "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.includes(".claude/worktrees")) {
      return;
    }
    mkdirSync(infoDir, { recursive: true });
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(excludeFile, `${current}${prefix}/.claude/worktrees/\n`, "utf8");
  } catch {
    // best-effort：写不进不影响功能（项目多半已在 .gitignore 忽略）。
  }
}

async function gitTolerant(args: string[]): Promise<void> {
  try {
    await runCommand("git", args, { timeoutMs: 5 * 60_000 });
  } catch {
    // worktree remove/prune 容错：分支/目录可能本就不存在，不抛、留给 GC 兜底。
  }
}

// 移除一棵工作树并 prune 元数据。容错。
export async function removeWorktree(localPath: string, wtPath: string): Promise<void> {
  await gitTolerant(["-C", localPath, "worktree", "remove", "--force", wtPath]);
  await gitTolerant(["-C", localPath, "worktree", "prune"]);
}

// 确保任务的工作树就绪。
// fresh（新任务）：删旧 → 从 origin/<base> 新建工作分支 workBranch 的工作树。
// recover（续接/打回重跑）：工作树在就复用；不在则从已有 workBranch 重建。
export async function ensureWorktree(
  localPath: string,
  wtPath: string,
  opts: { workBranch: string; baseRef?: string; fresh: boolean }
): Promise<void> {
  ensureWorktreesIgnored(localPath);
  if (opts.fresh) {
    await removeWorktree(localPath, wtPath);
    await runCommand(
      "git",
      ["-C", localPath, "worktree", "add", "--force", "-B", opts.workBranch, wtPath, opts.baseRef ?? opts.workBranch],
      { timeoutMs: 10 * 60_000 }
    );
    return;
  }

  // 工作树的 .git 是指向主仓的文件；存在即视为可复用。
  if (existsSync(path.join(wtPath, ".git"))) {
    return;
  }
  await gitTolerant(["-C", localPath, "worktree", "prune"]);
  await runCommand(
    "git",
    ["-C", localPath, "worktree", "add", "--force", wtPath, opts.workBranch],
    { timeoutMs: 10 * 60_000 }
  );
}

// GC：清理该项目主仓 .claude/worktrees/ 下、本 worker 管理的任务工作树（worktree-<UUID>）中已进终态
// （不在 keepTaskIds）的残留树。跨 waiting/resume/rejected 生命周期兜底 accepted/cancelled/merged/failed
// 后的孤儿树。严格只碰 worktree-<UUID> 命名的任务树——同目录下 Claude Code dev 工作树（名为 slug）、
// 会话树（worktree-conv-*）、主仓自身一律不动。
export async function gcWorktrees(localPath: string, keepTaskIds: Set<string>): Promise<void> {
  const root = worktreesRoot(localPath);
  let listed: string;
  try {
    const result = await runCommand("git", ["-C", localPath, "worktree", "list", "--porcelain"], {
      timeoutMs: 60_000
    });
    listed = result.stdout;
  } catch {
    return;
  }

  for (const line of listed.split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const wtPath = line.slice("worktree ".length).trim();
    // 仅碰我们 worktrees 目录下的；主仓自身与其它目录的工作树不动。
    if (path.relative(root, wtPath).startsWith("..")) {
      continue;
    }
    const name = path.basename(wtPath);
    // 严格只清任务树：名必须是 worktree-<UUID>，且该 UUID 不在 keep 集。其它（dev slug 树 / 会话树）跳过。
    if (!TASK_WT_RE.test(name)) {
      continue;
    }
    const taskId = name.slice(TASK_WT_PREFIX.length);
    if (!keepTaskIds.has(taskId)) {
      await removeWorktree(localPath, wtPath);
    }
  }
}
