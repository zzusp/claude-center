import { existsSync } from "node:fs";
import path from "node:path";
import type { WorkerConfig } from "./config.js";
import { runCommand } from "./shell.js";

// 真并发执行的工作树隔离：每个工作类任务一棵独立 git worktree，互不踩工作树（含同项目并发）。
// 主仓（localPath）只用于 fetch 与 worktree 管理，不被切到工作分支，全程保持稳定。

export function worktreesRoot(config: WorkerConfig): string {
  return path.join(config.dataDir, "worktrees");
}

export function worktreePathFor(config: WorkerConfig, taskId: string): string {
  return path.join(worktreesRoot(config), taskId);
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

// GC：清理该项目主仓下、属于我们 worktrees 目录、但任务已进终态（不在 keepTaskIds）的残留工作树。
// 跨 waiting/resume/rejected 生命周期靠它兜底 accepted/cancelled/merged/failed 后的孤儿树。
export async function gcWorktrees(
  config: WorkerConfig,
  localPath: string,
  keepTaskIds: Set<string>
): Promise<void> {
  const root = worktreesRoot(config);
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
    // 仅碰我们 worktrees 目录下的；主仓自身与其它工作树不动。
    if (path.relative(root, wtPath).startsWith("..")) {
      continue;
    }
    const taskId = path.basename(wtPath);
    if (!keepTaskIds.has(taskId)) {
      await removeWorktree(localPath, wtPath);
    }
  }
}
